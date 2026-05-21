import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import prettier from "prettier";
import { SpecSourceSchema, parseSpec } from "./parse.js";
import { validateOutputDir } from "../security/guards.js";
import { getCachedIR } from "../cache.js";
import { emit } from "../codegen/emitters/index.js";
import { toolSuccess, toolError } from "../types.js";
import type { GenerationManifest, SpecSource } from "../types.js";

const GENERATOR_VERSION = "1.0.0";
const IR_VERSION = "1";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const WriteServerInput = z.object({
  source: SpecSourceSchema,
  output_dir: z.string(),
  server_name: z.string(),
  base_url: z.string().optional(),
  auth_type: z.enum(["none", "bearer", "api_key_header", "api_key_query"]).optional(),
  auth_env_var: z.string().optional(),
  operation_ids: z.array(z.string()).optional(),
  dry_run: z.boolean().default(false),
  force: z.boolean().default(false), // bypasses collision check ONLY — not security guards
});

// ─── Tool handler ─────────────────────────────────────────────────────────────

export async function handleWriteServer(args: unknown) {
  try {
    const input = WriteServerInput.parse(args);
    const outputDir = validateOutputDir(input.output_dir);

    const parsed = await parseSpec(input.source);
    const ir = getCachedIR(parsed.specHash);
    if (!ir) throw new Error("IR cache miss after parse — this is a bug");

    let operations = ir;
    if (input.operation_ids && input.operation_ids.length > 0) {
      operations = ir.filter(op =>
        input.operation_ids!.includes(op.operationId) ||
        input.operation_ids!.includes(op.toolName)
      );
      if (operations.length === 0) {
        throw new Error(
          `No operations matched the provided filter. Available: ${ir.map(o => o.toolName).join(", ")}`
        );
      }
    }

    // Resolve auth: prefer explicit input, fall back to detected
    const authType =
      input.auth_type ??
      (parsed.detectedAuthSchemes[0]?.type ?? "none");
    const authEnvVar =
      input.auth_env_var ??
      parsed.detectedAuthSchemes[0]?.envVar;

    const baseUrl = input.base_url ?? parsed.baseUrl;

    const generated = emit(operations, "mcp", {
      baseUrl,
      serverName: input.server_name,
      authType,
      authEnvVar,
    });

    // Format TypeScript files with prettier
    const formattedFiles: Record<string, string> = {};
    const formatWarnings: string[] = [];
    for (const [filePath, content] of Object.entries(generated.files)) {
      if (filePath.endsWith(".ts")) {
        try {
          formattedFiles[filePath] = await prettier.format(content, { parser: "typescript" });
        } catch {
          formattedFiles[filePath] = content;
          formatWarnings.push(`prettier failed for ${filePath} — output unformatted`);
        }
      } else {
        formattedFiles[filePath] = content;
      }
    }

    const allWarnings = [...generated.warnings, ...formatWarnings, ...parsed.warnings];

    // Security: warn if the spec was fetched from a URL (untrusted content may embed prompt injection)
    if (input.source.type === "url") {
      allWarnings.push(
        `Security notice: tool descriptions in the generated server come directly from the spec at ${input.source.url}. ` +
          `Only install generated servers from specs you trust. Verify tool descriptions before use.`
      );
    }
    // Warn on suspiciously long descriptions (potential prompt injection vectors)
    const longDescOps = operations.filter(
      op => op.summary && op.summary.length > 300
    );
    if (longDescOps.length > 0) {
      allWarnings.push(
        `${longDescOps.length} operation(s) have unusually long summaries (>300 chars). ` +
          `Review these tool descriptions for unexpected content: ${longDescOps.map(o => o.toolName).join(", ")}`
      );
    }

    // Build manifest
    const manifest: GenerationManifest = {
      generatorVersion: GENERATOR_VERSION,
      irVersion: IR_VERSION,
      generatedAt: new Date().toISOString(),
      specSource: input.source as SpecSource,
      specHash: parsed.specHash,
      selectedOperations: operations.map(o => o.operationId),
      generatedTools: operations.map(o => o.toolName),
      options: {
        serverName: input.server_name,
        baseUrl,
        authType,
        authEnvVar,
      },
    };
    formattedFiles[".mcp-generator-manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";

    if (input.dry_run) {
      return toolSuccess({
        dry_run: true,
        files: formattedFiles,
        file_count: Object.keys(formattedFiles).length,
        warnings: allWarnings,
      });
    }

    // Collision check
    if (!input.force) {
      const conflicts = await findConflicts(outputDir, Object.keys(formattedFiles));
      if (conflicts.length > 0) {
        return toolError(
          `Output directory has ${conflicts.length} conflicting file(s): ${conflicts.join(", ")}. ` +
            `Use dry_run:true to preview, then force:true to overwrite.`
        );
      }
    }

    // Atomic write: temp dir → rename
    await writeAtomic(outputDir, formattedFiles);

    return toolSuccess({
      output_dir: outputDir,
      files_written: Object.keys(formattedFiles),
      warnings: allWarnings,
    });
  } catch (error) {
    return toolError(formatError(error));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findConflicts(outputDir: string, fileKeys: string[]): Promise<string[]> {
  const conflicts: string[] = [];
  for (const key of fileKeys) {
    try {
      await fs.access(path.join(outputDir, key));
      conflicts.push(key);
    } catch {
      // file doesn't exist — no conflict
    }
  }
  return conflicts;
}

async function writeAtomic(
  outputDir: string,
  files: Record<string, string>
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-gen-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const dest = path.resolve(path.join(tmpDir, relPath));
      // Guard against emitter producing path-traversal keys like "../../../etc/passwd"
      if (!dest.startsWith(tmpDir)) {
        throw new Error(`Generated file key escapes output directory: ${relPath}`);
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content, "utf8");
    }

    // Copy all files from tmpDir to outputDir, then remove tmpDir.
    // We use copyDir universally rather than rename to avoid Windows
    // EPERM issues with cross-directory renames in temp paths.
    await copyDir(tmpDir, outputDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid input: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// Exported for tests
export { writeAtomic };
