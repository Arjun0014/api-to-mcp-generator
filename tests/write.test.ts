import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { handleWriteServer } from "../src/tools/write.js";

const petstore = { type: "file" as const, path: path.resolve("tests/fixtures/petstore.yaml") };

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mcp-write-test-"));
}

describe("write_mcp_server — dry_run", () => {
  it("dry_run:true returns files without writing to disk", async () => {
    const outDir = await tmpDir();
    const result = await handleWriteServer({
      source: petstore,
      output_dir: path.join(outDir, "generated"),
      server_name: "petstore-test",
      dry_run: true,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.dry_run).toBe(true);
    expect(Object.keys(data.files)).toContain("src/index.ts");
    expect(Object.keys(data.files)).toContain(".mcp-generator-manifest.json");

    // Confirm nothing was written to disk
    await expect(fs.access(path.join(outDir, "generated"))).rejects.toThrow();

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it("dry_run:false is the default (Zod .default(false) behavior)", async () => {
    const outDir = await tmpDir();
    const result = await handleWriteServer({
      source: petstore,
      output_dir: path.join(outDir, "generated"),
      server_name: "petstore-test",
      // dry_run not specified — should default to false and write
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.dry_run).toBeUndefined(); // not dry_run response
    expect(data.files_written).toBeDefined();

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

describe("write_mcp_server — manifest", () => {
  it("writes .mcp-generator-manifest.json with correct shape", async () => {
    const outDir = await tmpDir();
    const generatedDir = path.join(outDir, "generated");

    await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
    });

    const manifestRaw = await fs.readFile(
      path.join(generatedDir, ".mcp-generator-manifest.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestRaw);

    expect(manifest.generatorVersion).toBe("1.0.0");
    expect(manifest.irVersion).toBe("1");
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.specHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Array.isArray(manifest.generatedTools)).toBe(true);
    expect(manifest.generatedTools.length).toBeGreaterThan(0);
    expect(manifest.options.serverName).toBe("petstore-test");

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it("manifest contains snake_case toolNames", async () => {
    const outDir = await tmpDir();
    const generatedDir = path.join(outDir, "generated");

    await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(generatedDir, ".mcp-generator-manifest.json"), "utf8")
    );

    for (const tool of manifest.generatedTools as string[]) {
      expect(tool).toMatch(/^[a-z][a-z0-9_]*$/);
    }

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

describe("write_mcp_server — collision detection", () => {
  it("refuses to overwrite by default when files exist", async () => {
    const outDir = await tmpDir();
    const generatedDir = path.join(outDir, "generated");

    // First write
    await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
    });

    // Second write — should fail without force
    const result = await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("conflicting");

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it("force:true overwrites existing files", async () => {
    const outDir = await tmpDir();
    const generatedDir = path.join(outDir, "generated");

    // First write
    await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
    });

    // Second write with force
    const result = await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
      force: true,
    });

    expect(result.isError).toBeFalsy();

    await fs.rm(outDir, { recursive: true, force: true });
  });
});

describe("write_mcp_server — security", () => {
  it("blocks path traversal in output_dir", async () => {
    const result = await handleWriteServer({
      source: petstore,
      output_dir: process.platform === "win32" ? "C:\\Windows\\output" : "/etc/output",
      server_name: "evil-server",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/unsafe|blocked/i);
  });

  it("force:true does not bypass path traversal guard", async () => {
    const result = await handleWriteServer({
      source: petstore,
      output_dir: process.platform === "win32" ? "C:\\Windows\\output" : "/etc/output",
      server_name: "evil-server",
      force: true,
    });

    expect(result.isError).toBe(true);
  });
});

describe("write_mcp_server — generated content", () => {
  it("generates src/index.ts with tool registrations", async () => {
    const outDir = await tmpDir();
    const generatedDir = path.join(outDir, "generated");

    await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
    });

    const indexTs = await fs.readFile(path.join(generatedDir, "src/index.ts"), "utf8");
    expect(indexTs).toContain("list_pets");
    expect(indexTs).toContain("create_pets");
    expect(indexTs).toContain("Server");

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it("generates src/client.ts with base URL", async () => {
    const outDir = await tmpDir();
    const generatedDir = path.join(outDir, "generated");

    await handleWriteServer({
      source: petstore,
      output_dir: generatedDir,
      server_name: "petstore-test",
    });

    const clientTs = await fs.readFile(path.join(generatedDir, "src/client.ts"), "utf8");
    expect(clientTs).toContain("petstore.example.com");

    await fs.rm(outDir, { recursive: true, force: true });
  });

  it("auto-detects bearer auth from stripe spec", async () => {
    const outDir = await tmpDir();
    const generatedDir = path.join(outDir, "generated");

    await handleWriteServer({
      source: { type: "file", path: path.resolve("tests/fixtures/stripe-subset.yaml") },
      output_dir: generatedDir,
      server_name: "stripe-test",
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(generatedDir, ".mcp-generator-manifest.json"), "utf8")
    );
    expect(manifest.options.authType).toBe("bearer");

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
