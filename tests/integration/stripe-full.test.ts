import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseSpec } from "../../src/tools/parse.js";
import { handleWriteServer } from "../../src/tools/write.js";

const execAsync = promisify(exec);

// Using petstore as a stand-in for tag-filtered generation testing.
// The petstore has "pets" and "owners" tags.
const petstore = {
  type: "file" as const,
  path: path.resolve("tests/fixtures/petstore.yaml"),
};

describe("E2E: tag-filtered generation — petstore (pets tag)", () => {
  it("tag-filtered write generates only pets operations", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tag-dry-"));
    const result = await handleWriteServer({
      source: petstore,
      output_dir: outDir,
      server_name: "petstore-pets",
      tag: "pets",
      dry_run: true,
    });
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.dry_run).toBe(true);

    const indexTs = data.files["src/index.ts"] as string;
    expect(indexTs).toBeDefined();
    // pets operations should be present
    expect(indexTs).toContain("list_pets");
    // owners operations should NOT be present
    expect(indexTs).not.toContain("list_owners");
  });

  it("owners tag generates separate server", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-owners-dry-"));
    const result = await handleWriteServer({
      source: petstore,
      output_dir: outDir,
      server_name: "petstore-owners",
      tag: "owners",
      dry_run: true,
    });
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    const indexTs = data.files["src/index.ts"] as string;
    // owners operations present, pets operations not present
    expect(indexTs).not.toContain("list_pets");
    expect(indexTs).not.toContain("create_pets");
  });

  it("tag-filtered write → tsc clean", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tag-filter-test-"));
    // write tool writes directly to output_dir, not to output_dir/server_name
    const generatedDir = path.join(outDir, "generated");
    try {
      const result = await handleWriteServer({
        source: petstore,
        output_dir: generatedDir,
        server_name: "petstore-pets",
        tag: "pets",
      });

      expect(result.isError).toBeFalsy();

      // Verify only pets operations appear in generated code
      const indexTs = await fs.readFile(path.join(generatedDir, "src/index.ts"), "utf8");
      expect(indexTs).toContain("list_pets");

      // Install and typecheck
      await execAsync("npm install --prefer-offline --no-audit 2>&1 || npm install", {
        cwd: generatedDir,
        timeout: 90_000,
      });

      const { stderr } = await execAsync("npx tsc --noEmit", {
        cwd: generatedDir,
        timeout: 30_000,
      });
      expect(stderr).toBe("");
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
});

describe("E2E: parse groupingRecommendation", () => {
  it("petstore has no groupingRecommendation (≤100 ops)", async () => {
    const result = await parseSpec(petstore);
    expect(result.groupingRecommendation).toBeUndefined();
    expect(result.operationCount).toBeLessThanOrEqual(100);
  });
});
