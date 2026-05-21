import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { validateOutputDir } from "../security/guards.js";
import { toolSuccess, toolError } from "../types.js";
import type { GenerationManifest } from "../types.js";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const GenerateConfigInput = z.object({
  output_dir: z.string(),
  server_name: z.string(),
  env_vars: z.record(z.string()).optional(),
});

// ─── Tool handler ─────────────────────────────────────────────────────────────

export async function handleGenerateConfig(args: unknown) {
  try {
    const input = GenerateConfigInput.parse(args);
    const outputDir = validateOutputDir(input.output_dir);

    // Read manifest to auto-populate env vars if present
    const manifest = await readManifest(outputDir);
    const authEnvVar = manifest?.options.authEnvVar;
    const authType = manifest?.options.authType ?? "none";

    const envVars: Record<string, string> = { ...input.env_vars };
    if (authType !== "none" && authEnvVar && !(authEnvVar in envVars)) {
      envVars[authEnvVar] = "";
    }

    const config = {
      mcpServers: {
        [input.server_name]: {
          command: "node",
          args: ["dist/index.js"],
          cwd: outputDir,
          ...(Object.keys(envVars).length > 0 ? { env: envVars } : {}),
        },
      },
    };

    const configPath = path.join(outputDir, ".mcp.json");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    return toolSuccess({
      config_path: configPath,
      config,
    });
  } catch (error) {
    return toolError(formatError(error));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readManifest(outputDir: string): Promise<GenerationManifest | null> {
  try {
    const raw = await fs.readFile(
      path.join(outputDir, ".mcp-generator-manifest.json"),
      "utf8"
    );
    return JSON.parse(raw) as GenerationManifest;
  } catch {
    return null;
  }
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid input: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}
