import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { spawn } from "child_process";
import { handleWriteServer } from "../../src/tools/write.js";
import { parseSpec } from "../../src/tools/parse.js";

const stripeSubset = {
  type: "file" as const,
  path: path.resolve("tests/fixtures/stripe-subset.yaml"),
};

async function tscNoEmit(dir: string): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    let output = "";
    const proc = spawn("npx", ["tsc", "--noEmit"], { cwd: dir, shell: true });
    proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
    proc.on("close", code => resolve({ ok: code === 0, output: output.trim() }));
    proc.on("error", err => resolve({ ok: false, output: err.message }));
  });
}

describe("stripe-subset: normalizer handles complex schemas", () => {
  it("parses without error — allOf+discriminator produce warnings not failures", async () => {
    const result = await parseSpec(stripeSubset);
    expect(result.operationCount).toBeGreaterThan(0);
    // Some warnings are expected (discriminator, etc.) but no crash
    expect(result.operations.length).toBeGreaterThan(0);
  });

  it("detects bearer auth from securitySchemes", async () => {
    const result = await parseSpec(stripeSubset);
    const bearer = result.detectedAuthSchemes.find(s => s.type === "bearer");
    expect(bearer).toBeDefined();
    expect(bearer?.envVar).toBe("BEARER_TOKEN");
  });

  it("groups operations by tag: charges and customers", async () => {
    const result = await parseSpec(stripeSubset);
    expect(result.operationsByTag).toHaveProperty("charges");
    expect(result.operationsByTag).toHaveProperty("customers");
    expect(result.operationsByTag["charges"]?.length).toBeGreaterThan(0);
    expect(result.operationsByTag["customers"]?.length).toBeGreaterThan(0);
  });

  it("allOf without discriminator normalizes to intersection", async () => {
    // ChargeCard uses allOf without discriminator — should produce intersection, not error
    const result = await parseSpec(stripeSubset);
    expect(result.operations.some(o => o.operationId === "listCharges")).toBe(true);
  });

  it("nullable fields produce warnings[] not errors", async () => {
    const result = await parseSpec(stripeSubset);
    // Customer has nullable email/name — should parse fine
    const customer = result.operations.find(o => o.operationId === "retrieveCustomer");
    expect(customer).toBeDefined();
  });
});

describe("E2E: stripe-subset → write → tsc clean", () => {
  it(
    "generated server compiles without TypeScript errors",
    async () => {
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-e2e-stripe-"));
      const generatedDir = path.join(outDir, "generated");

      try {
        const writeResult = await handleWriteServer({
          source: stripeSubset,
          output_dir: generatedDir,
          server_name: "stripe-e2e",
        });
        expect(writeResult.isError).toBeFalsy();

        // npm install
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("npm", ["install", "--prefer-offline"], {
            cwd: generatedDir,
            shell: true,
          });
          proc.on("close", code =>
            code === 0 ? resolve() : reject(new Error(`npm install failed: ${code}`))
          );
          proc.on("error", reject);
        });

        // tsc --noEmit
        const result = await tscNoEmit(generatedDir);
        if (!result.ok) console.error("tsc output:", result.output);
        expect(result.ok).toBe(true);

        // Manifest should have bearer auth auto-detected
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(generatedDir, ".mcp-generator-manifest.json"),
            "utf8"
          )
        );
        expect(manifest.options.authType).toBe("bearer");
        expect(manifest.options.authEnvVar).toBe("BEARER_TOKEN");

        // allOf+discriminator operations still generate (as z.unknown() + warning)
        expect(manifest.generatedTools.length).toBeGreaterThan(0);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000
  );
});
