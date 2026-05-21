import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { handleWriteServer } from "../../src/tools/write.js";

const petstore = {
  type: "file" as const,
  path: path.resolve("tests/fixtures/petstore.yaml"),
};

async function compileServer(outputDir: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    const proc = spawn("npx", ["tsc", "--noEmit"], {
      cwd: outputDir,
      shell: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.stdout?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", code => resolve({ ok: code === 0, stderr: stderr.trim() }));
    proc.on("error", err => resolve({ ok: false, stderr: err.message }));
  });
}

async function buildServer(outputDir: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    const proc = spawn("npx", ["tsc"], {
      cwd: outputDir,
      shell: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.stdout?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", code => resolve({ ok: code === 0, stderr: stderr.trim() }));
    proc.on("error", err => resolve({ ok: false, stderr: err.message }));
  });
}

async function probeMcpServer(
  outputDir: string
): Promise<{ toolCount: number; toolNames: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["dist/index.js"], {
      cwd: outputDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!proc.stdin || !proc.stdout) {
      reject(new Error("Failed to open stdio pipes"));
      return;
    }

    const stdin = proc.stdin;
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("MCP probe timed out"));
    }, 15_000);

    const rl = createInterface({ input: proc.stdout as NodeJS.ReadableStream });
    let initialized = false;

    proc.on("error", err => { clearTimeout(timeout); reject(err); });

    proc.on("exit", code => {
      if (!initialized) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before responding`));
      }
    });

    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }) + "\n"
    );

    rl.on("line", line => {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
        if (msg.id === 1 && !initialized) {
          initialized = true;
          stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
          );
          stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"
          );
        } else if (msg.id === 2) {
          clearTimeout(timeout);
          const tools = msg.result?.tools ?? [];
          proc.kill();
          resolve({
            toolCount: tools.length,
            toolNames: tools.map(t => t.name),
          });
        }
      } catch {
        // non-JSON line
      }
    });
  });
}

describe("E2E: petstore → write → compile → MCP probe", () => {
  it(
    "full pipeline passes",
    async () => {
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-e2e-petstore-"));
      const generatedDir = path.join(outDir, "generated");

      try {
        // Step 1: Generate the server
        const writeResult = await handleWriteServer({
          source: petstore,
          output_dir: generatedDir,
          server_name: "petstore-e2e",
        });
        expect(writeResult.isError).toBeFalsy();

        // Step 2: npm install in generated dir
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("npm", ["install", "--prefer-offline"], {
            cwd: generatedDir,
            shell: true,
          });
          proc.on("close", code => code === 0 ? resolve() : reject(new Error(`npm install failed: ${code}`)));
          proc.on("error", reject);
        });

        // Step 3: TypeScript compile check
        const compileResult = await compileServer(generatedDir);
        expect(compileResult.ok).toBe(true);
        if (!compileResult.ok) {
          console.error("tsc output:", compileResult.stderr);
        }

        // Step 4: Build to dist/
        const buildResult = await buildServer(generatedDir);
        expect(buildResult.ok).toBe(true);

        // Step 5: MCP probe
        const probeResult = await probeMcpServer(generatedDir);
        expect(probeResult.toolCount).toBeGreaterThan(0);
        expect(probeResult.toolNames).toContain("list_pets");
        expect(probeResult.toolNames).toContain("create_pets");
        expect(probeResult.toolNames).toContain("show_pet_by_id");
      } finally {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000 // npm install can take a while
  );
});
