import SwaggerParser from "@apidevtools/swagger-parser";
import axios from "axios";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import type { OpenAPIV3 } from "openapi-types";
import { validateSourceUrl, validateFilePath, checkRawSize, checkDereferencedSize } from "../security/guards.js";
import { normalizeSpec, detectAuthSchemes } from "../codegen/normalizer.js";
import { hashSpec, getCachedIR, setCachedIR } from "../cache.js";
import { toolSuccess, toolError } from "../types.js";
import type { ParseResult, OperationSummary, SpecSource } from "../types.js";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const SpecSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.string() }),
  z.object({ type: z.literal("file"), path: z.string() }),
]);

export const ParseSpecInput = z.object({
  source: SpecSourceSchema,
  auth_header: z.string().optional(),
});

// ─── Tool handler ─────────────────────────────────────────────────────────────

export async function handleParseSpec(args: unknown) {
  try {
    const input = ParseSpecInput.parse(args);
    const result = await parseSpec(input.source, input.auth_header);
    return toolSuccess(result);
  } catch (error) {
    return toolError(formatError(error));
  }
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function parseSpec(
  source: SpecSource,
  authHeader?: string
): Promise<ParseResult> {
  const { rawBytes, specPath, tmpDir } = await fetchSpec(source, authHeader);

  try {
    checkRawSize(rawBytes);

    const specHash = hashSpec(rawBytes);

    // Check cache — if hit, skip dereference + normalization entirely
    let operations = getCachedIR(specHash);
    let doc: OpenAPIV3.Document | null = null;
    let normalizeWarnings: string[] = [];

    if (!operations) {
      doc = await withTimeout(
        SwaggerParser.dereference(specPath) as Promise<OpenAPIV3.Document>,
        30_000,
        "Spec parse timed out after 30s"
      );

      checkDereferencedSize(doc);

      const normalized = normalizeSpec(doc);
      operations = normalized.operations;
      normalizeWarnings = normalized.warnings;
      setCachedIR(specHash, operations);
    } else {
      // Re-parse for metadata (info, servers, paths) — but skip normalization
      doc = await withTimeout(
        SwaggerParser.dereference(specPath) as Promise<OpenAPIV3.Document>,
        30_000,
        "Spec parse timed out after 30s"
      );
    }

    // Build operation summaries
    const operationSummaries: OperationSummary[] = operations.map(op => ({
      operationId: op.operationId,
      toolName: op.toolName,
      method: op.method,
      path: op.path,
      summary: op.summary,
      hasRequestBody: op.requestBody !== undefined,
      responseCodes: op.responses.map(r => r.statusCode),
    }));

    // Tag grouping
    const operationsByTag: Record<string, OperationSummary[]> = {};
    for (const [pathStr, pathItem] of Object.entries(doc.paths ?? {})) {
      if (!pathItem || "$ref" in pathItem) continue;
      const item = pathItem as OpenAPIV3.PathItemObject;
      for (const method of ["get", "post", "put", "delete", "patch"] as const) {
        const op = item[method];
        if (!op) continue;
        const tags = op.tags ?? ["untagged"];
        const summary = operationSummaries.find(
          s => s.path === pathStr && s.method === method
        );
        if (!summary) continue;
        for (const tag of tags) {
          (operationsByTag[tag] ??= []).push(summary);
        }
      }
    }

    // Auth schemes
    const detectedAuthSchemes = detectAuthSchemes(doc);

    // Operation count guard
    const opWarnings = [...normalizeWarnings];

    if (operations.length > 100) {
      throw new Error(
        `Spec has ${operations.length} operations (limit: 100). ` +
          `Use operation_ids to filter. Available tags: ${Object.keys(operationsByTag).join(", ")}`
      );
    }

    if (operations.length > 50) {
      opWarnings.push(
        `Large spec (${operations.length} operations) — consider filtering by tag using operation_ids to focus generation`
      );
    }

    return {
      title: doc.info.title,
      version: doc.info.version,
      baseUrl: extractBaseUrl(doc),
      operationCount: operations.length,
      operations: operationSummaries,
      operationsByTag,
      detectedAuthSchemes,
      specHash,
      warnings: opWarnings,
    };
  } finally {
    // Clean up temp directory created for URL-fetched specs
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchSpec(
  source: SpecSource,
  authHeader?: string
): Promise<{ rawBytes: Buffer; specPath: string; tmpDir?: string }> {
  if (source.type === "url") {
    validateSourceUrl(source.url);

    const response = await axios.get<ArrayBuffer>(source.url, {
      responseType: "arraybuffer",
      headers: authHeader ? { Authorization: authHeader } : {},
      timeout: 30_000,
      maxContentLength: 10 * 1024 * 1024,
      maxRedirects: 0, // prevent redirect-based SSRF bypass
    });

    const rawBytes = Buffer.from(response.data);

    // Write to temp file for swagger-parser (requires a path)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-spec-"));
    const ext = source.url.endsWith(".json") ? ".json" : ".yaml";
    const specPath = path.join(tmpDir, `spec${ext}`);
    await fs.writeFile(specPath, rawBytes);

    return { rawBytes, specPath, tmpDir };
  } else {
    const resolved = validateFilePath(source.path);
    const rawBytes = await fs.readFile(resolved);
    return { rawBytes, specPath: resolved };
  }
}

function extractBaseUrl(doc: OpenAPIV3.Document): string {
  const server = doc.servers?.[0];
  if (!server) return "";
  return server.url;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid input: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}
