import SwaggerParser from "@apidevtools/swagger-parser";
import axios from "axios";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import type { OpenAPIV3, OpenAPIV2 } from "openapi-types";
import { validateSourceUrl, validateFilePath, checkRawSize, checkDereferencedSize } from "../security/guards.js";
import { normalizeDoc, detectAuthSchemes, detectAuthSchemesV2 } from "../codegen/normalizer.js";
import { hashSpec, getCachedEntry, setCachedIR } from "../cache.js";
import { toolSuccess, toolError } from "../types.js";
import type { ParseResult, OperationSummary, SpecSource, GroupingRecommendation, TagGroup } from "../types.js";
import type { NormalizedOperation } from "../ir/types.js";

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
  const sourceUrl = source.type === "url" ? source.url : undefined;

  try {
    checkRawSize(rawBytes);

    const specHash = hashSpec(rawBytes);

    // Cache HIT: skip dereference + normalization entirely.
    // operationsByTag computed inline from op.tags (no re-parse needed).
    // title/version/baseUrl from CacheEntry.metadata.
    const cached = getCachedEntry(specHash);
    if (cached) {
      const operationSummaries = buildOperationSummaries(cached.ir);
      const operationsByTag = buildOperationsByTagFromIR(cached.ir);
      const opWarnings: string[] = [];

      if (cached.ir.length > 50) {
        opWarnings.push(
          `Large spec (${cached.ir.length} operations) — consider filtering by tag using the tag parameter`
        );
      }

      const result: ParseResult = {
        title: cached.metadata.title,
        version: cached.metadata.version,
        baseUrl: cached.metadata.baseUrl,
        operationCount: cached.ir.length,
        operations: operationSummaries,
        operationsByTag,
        detectedAuthSchemes: cached.metadata.detectedAuthSchemes,
        specHash,
        warnings: opWarnings,
      };

      if (cached.ir.length > 100) {
        result.groupingRecommendation = buildGroupingRecommendation(
          operationsByTag,
          cached.metadata.title
        );
      }

      return result;
    }

    // Cache MISS — dereference, detect version, normalize.
    const rawDoc = await withTimeout(
      SwaggerParser.dereference(specPath) as Promise<OpenAPIV3.Document | OpenAPIV2.Document>,
      30_000,
      "Spec parse timed out after 30s"
    );

    checkDereferencedSize(rawDoc);

    const isSwagger2 = (rawDoc as OpenAPIV2.Document).swagger === "2.0";
    const { operations, namedSchemas, warnings: normalizeWarnings } = normalizeDoc(rawDoc);

    const detectedAuthSchemes = isSwagger2
      ? detectAuthSchemesV2(rawDoc as OpenAPIV2.Document)
      : detectAuthSchemes(rawDoc as OpenAPIV3.Document);

    const baseUrl = isSwagger2
      ? extractBaseUrlV2(rawDoc as OpenAPIV2.Document)
      : extractBaseUrl(rawDoc as OpenAPIV3.Document, sourceUrl);

    const title = rawDoc.info.title;
    const version = String(rawDoc.info.version ?? "");

    // Store in cache with metadata and namedSchemas for use by write_mcp_server
    setCachedIR(specHash, operations, namedSchemas, { title, version, baseUrl, detectedAuthSchemes });

    const operationSummaries = buildOperationSummaries(operations);
    const operationsByTag = buildOperationsByTagFromIR(operations);

    const opWarnings = [...normalizeWarnings];
    if (operations.length > 50) {
      opWarnings.push(
        `Large spec (${operations.length} operations) — consider filtering by tag using the tag parameter`
      );
    }

    const result: ParseResult = {
      title,
      version,
      baseUrl,
      operationCount: operations.length,
      operations: operationSummaries,
      operationsByTag,
      detectedAuthSchemes,
      specHash,
      warnings: opWarnings,
    };

    if (operations.length > 100) {
      result.groupingRecommendation = buildGroupingRecommendation(operationsByTag, title);
    }

    return result;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildOperationSummaries(operations: NormalizedOperation[]): OperationSummary[] {
  return operations.map(op => ({
    operationId: op.operationId,
    toolName: op.toolName,
    method: op.method,
    path: op.path,
    summary: op.summary,
    hasRequestBody: op.requestBody !== undefined,
    responseCodes: op.responses.map(r => r.statusCode),
  }));
}

// Build operationsByTag from normalized IR operations.
// Uses op.tags (V2 addition). Ops with no tags fall into "_untagged".
// No doc re-parse needed — works from cached IR on both HIT and MISS paths.
function buildOperationsByTagFromIR(
  operations: NormalizedOperation[]
): Record<string, OperationSummary[]> {
  const result: Record<string, OperationSummary[]> = {};
  for (const op of operations) {
    const tags = [...new Set(op.tags.length > 0 ? op.tags : ["_untagged"])];
    const summary: OperationSummary = {
      operationId: op.operationId,
      toolName: op.toolName,
      method: op.method,
      path: op.path,
      summary: op.summary,
      hasRequestBody: op.requestBody !== undefined,
      responseCodes: op.responses.map(r => r.statusCode),
    };
    for (const tag of tags) {
      (result[tag] ??= []).push(summary);
    }
  }
  return result;
}

function buildGroupingRecommendation(
  operationsByTag: Record<string, OperationSummary[]>,
  specTitle: string
): GroupingRecommendation {
  const slugBase = specTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "api";

  const groups: TagGroup[] = Object.entries(operationsByTag)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tag, ops]) => ({
      tag,
      count: ops.length,
      suggestedServer: `${slugBase}-${tag.replace(/^_/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "misc"}`,
    }));

  return {
    strategy: "generate_by_tag",
    groups,
    totalGroups: groups.length,
    fitsInOneServer: false,
  };
}

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
      maxRedirects: 0,
    });

    const rawBytes = Buffer.from(response.data);
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

function extractBaseUrl(doc: OpenAPIV3.Document, sourceUrl?: string): string {
  const server = doc.servers?.[0];
  if (!server) return "";

  const url = server.url;
  if (url.startsWith("/") && sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      return `${parsed.protocol}//${parsed.host}${url}`;
    } catch {
      return url;
    }
  }

  return url;
}

function extractBaseUrlV2(doc: OpenAPIV2.Document): string {
  const host = doc.host;
  if (!host) return "";

  const basePath = doc.basePath ?? "";
  const schemes = doc.schemes ?? ["https"];
  const scheme = schemes.includes("https") ? "https" : (schemes[0] ?? "https");

  return `${scheme}://${host}${basePath}`;
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
