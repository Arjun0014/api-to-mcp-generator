import { spawn } from "child_process";
import { createInterface } from "readline";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { validateOutputDir } from "../security/guards.js";
import { toolSuccess, toolError } from "../types.js";
import type { ValidationResult, ValidationCheck } from "../types.js";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const ValidateInput = z.object({
  output_dir: z.string(),
  timeout_ms: z.number().default(120_000),
});

// ─── Timeouts ─────────────────────────────────────────────────────────────────

const PHASE_TIMEOUTS = {
  npm_install: 90_000,
  typescript_compile: 30_000,
  server_starts: 10_000,
  tools_list: 10_000,
};

// ─── Tool handler ─────────────────────────────────────────────────────────────

export async function handleRunValidation(args: unknown) {
  try {
    const input = ValidateInput.parse(args);
    const outputDir = validateOutputDir(input.output_dir);

    // Manifest check — warn if missing but proceed
    const warnings: string[] = [];
    const hasManifest = await fileExists(path.join(outputDir, ".mcp-generator-manifest.json"));
    if (!hasManifest) {
      warnings.push(
        "No .mcp-generator-manifest.json found — this may not be a generated server"
      );
    }

    const result = await runValidation(outputDir, warnings);
    return toolSuccess(result);
  } catch (error) {
    return toolError(formatError(error));
  }
}

// ─── Core validation ──────────────────────────────────────────────────────────

async function runValidation(outputDir: string, warnings: string[]): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];
  const errors: string[] = [];

  // Phase 1: npm install (skip if deps current)
  const installCheck = await runNpmInstall(outputDir);
  checks.push(installCheck);
  if (!installCheck.passed && !installCheck.skipped) {
    errors.push(`npm install failed: ${installCheck.error ?? installCheck.output ?? ""}`);
    return { passed: false, checks, errors, warnings };
  }

  // Phase 2: TypeScript compile
  const compileCheck = await runTscCompile(outputDir);
  checks.push(compileCheck);
  if (!compileCheck.passed) {
    errors.push(`TypeScript compile failed:\n${compileCheck.output ?? ""}`);
    return { passed: false, checks, errors, warnings };
  }

  // Phase 3 + 4: Spawn server and probe
  const { startsCheck, toolsCheck } = await runMcpProbe(outputDir);
  checks.push(startsCheck);
  checks.push(toolsCheck);

  if (!startsCheck.passed) errors.push(`Server failed to start: ${startsCheck.error ?? ""}`);
  if (!toolsCheck.passed) errors.push(`MCP probe failed: ${toolsCheck.error ?? ""}`);

  const passed = checks.every(c => c.passed || c.skipped);
  return { passed, checks, errors, warnings };
}

async function runNpmInstall(outputDir: string): Promise<ValidationCheck> {
  const start = Date.now();

  // Skip if dependencies are current
  const shouldSkip = await depsAreCurrent(outputDir);
  if (shouldSkip) {
    return {
      name: "npm_install",
      passed: true,
      skipped: true,
      elapsedMs: Date.now() - start,
      output: "dependencies already installed, skipping npm install",
    };
  }

  return runCommand("npm", ["install"], outputDir, PHASE_TIMEOUTS.npm_install, "npm_install");
}

async function runTscCompile(outputDir: string): Promise<ValidationCheck> {
  const check = await runCommand(
    "npx",
    ["tsc", "--noEmit"],
    outputDir,
    PHASE_TIMEOUTS.typescript_compile,
    "typescript_compile"
  );
  // Also run actual build to produce dist/
  if (check.passed) {
    await runCommand("npx", ["tsc"], outputDir, PHASE_TIMEOUTS.typescript_compile, "typescript_compile");
  }
  return check;
}

async function runMcpProbe(
  outputDir: string
): Promise<{ startsCheck: ValidationCheck; toolsCheck: ValidationCheck }> {
  const startTime = Date.now();

  return new Promise(resolve => {
    const startsCheck: ValidationCheck = {
      name: "server_starts",
      passed: false,
      elapsedMs: 0,
    };
    const toolsCheck: ValidationCheck = {
      name: "tools_list",
      passed: false,
      elapsedMs: 0,
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("node", ["dist/index.js"], {
        cwd: outputDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      startsCheck.error = `Failed to spawn node: ${String(err)}`;
      startsCheck.elapsedMs = Date.now() - startTime;
      toolsCheck.elapsedMs = 0;
      resolve({ startsCheck, toolsCheck });
      return;
    }

    if (!proc.stdout || !proc.stdin) {
      startsCheck.error = "Failed to open stdio pipes";
      startsCheck.elapsedMs = Date.now() - startTime;
      resolve({ startsCheck, toolsCheck });
      return;
    }

    const stdin = proc.stdin;
    const stdout = proc.stdout;

    // settled + settle() guard prevents double-resolve across timeout/error/exit/rl paths
    let settled = false;
    function settle(result: { startsCheck: ValidationCheck; toolsCheck: ValidationCheck }) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    const timeout = setTimeout(() => {
      proc.kill();
      if (!startsCheck.passed) {
        startsCheck.error = "Server startup timeout";
        startsCheck.elapsedMs = Date.now() - startTime;
      }
      toolsCheck.error = "MCP probe timeout";
      toolsCheck.elapsedMs = Date.now() - startTime;
      settle({ startsCheck, toolsCheck });
    }, PHASE_TIMEOUTS.server_starts + PHASE_TIMEOUTS.tools_list);

    const rl = createInterface({ input: stdout as NodeJS.ReadableStream });
    let initialized = false;

    proc.on("error", err => {
      startsCheck.error = err.message;
      startsCheck.elapsedMs = Date.now() - startTime;
      settle({ startsCheck, toolsCheck });
    });

    proc.on("exit", code => {
      if (!initialized) {
        startsCheck.error = `Process exited with code ${code} before responding`;
        startsCheck.elapsedMs = Date.now() - startTime;
        settle({ startsCheck, toolsCheck });
      }
    });

    // Send MCP initialize
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "validator", version: "1.0.0" },
      },
    });
    stdin.write(initMsg + "\n");

    rl.on("line", line => {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };

        if (msg.id === 1 && !initialized) {
          initialized = true;
          startsCheck.passed = true;
          startsCheck.elapsedMs = Date.now() - startTime;

          // Send initialized notification + tools/list
          stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
          );
          stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"
          );
        } else if (msg.id === 2) {
          const toolCount = (msg.result?.tools ?? []).length;
          toolsCheck.passed = toolCount > 0;
          toolsCheck.elapsedMs = Date.now() - startTime;
          toolsCheck.output = `${toolCount} tool(s) registered`;
          if (toolCount === 0) toolsCheck.error = "Server returned 0 tools";
          proc.kill();
          settle({ startsCheck, toolsCheck });
        }
      } catch {
        // non-JSON lines (startup messages) — ignore
      }
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function depsAreCurrent(outputDir: string): Promise<boolean> {
  try {
    const pkgJson = await fs.readFile(path.join(outputDir, "package.json"), "utf8");
    const lockFile = await fs.readFile(path.join(outputDir, "package-lock.json"), "utf8");
    const nodeModulesExists = await fileExists(path.join(outputDir, "node_modules"));
    if (!nodeModulesExists) return false;

    const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string> };
    const depsHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(pkg.dependencies ?? {}))
      .digest("hex");

    // Store hash check in a marker file
    const markerPath = path.join(outputDir, ".mcp-gen-install-hash");
    try {
      const stored = await fs.readFile(markerPath, "utf8");
      return stored.trim() === depsHash;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  name: ValidationCheck["name"]
): Promise<ValidationCheck> {
  const start = Date.now();
  return new Promise(resolve => {
    let output = "";
    let proc: ReturnType<typeof spawn>;

    try {
      // shell: false (default) — we don't need shell features and shell:true
      // is a latent injection surface if cmd ever becomes dynamic
      proc = spawn(cmd, args, { cwd });
    } catch (err) {
      resolve({
        name,
        passed: false,
        elapsedMs: Date.now() - start,
        error: `Failed to spawn ${cmd}: ${String(err)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      proc.kill();
      resolve({
        name,
        passed: false,
        elapsedMs: Date.now() - start,
        error: `Timeout after ${timeoutMs}ms`,
        output,
      });
    }, timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

    proc.on("close", code => {
      clearTimeout(timer);
      resolve({
        name,
        passed: code === 0,
        elapsedMs: Date.now() - start,
        output: output.trim() || undefined,
        error: code !== 0 ? `Exit code ${code}` : undefined,
      });
    });

    proc.on("error", err => {
      clearTimeout(timer);
      resolve({
        name,
        passed: false,
        elapsedMs: Date.now() - start,
        error: err.message,
      });
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid input: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}
