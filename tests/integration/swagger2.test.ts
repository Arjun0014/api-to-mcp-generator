import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseSpec } from "../../src/tools/parse.js";
import { handleWriteServer } from "../../src/tools/write.js";

const execAsync = promisify(exec);

const jiraSwagger2 = {
  type: "file" as const,
  path: path.resolve("tests/fixtures/jira-swagger2-subset.yaml"),
};

describe("E2E: Swagger 2.0 — jira-swagger2-subset", () => {
  it("parses Swagger 2.0 spec and returns operations", async () => {
    const result = await parseSpec(jiraSwagger2);
    expect(result.operationCount).toBeGreaterThan(0);
    expect(result.title).toBe("Jira API Subset");
  });

  it("detects oauth2 flow:application → oauth_client_credentials", async () => {
    const result = await parseSpec(jiraSwagger2);
    const oauth = result.detectedAuthSchemes.find(s => s.type === "oauth_client_credentials");
    expect(oauth).toBeDefined();
    expect(oauth?.tokenEndpoint).toBe("https://auth.atlassian.com/oauth/token");
  });

  it("detects apiKey in header scheme", async () => {
    const result = await parseSpec(jiraSwagger2);
    const apiKey = result.detectedAuthSchemes.find(s => s.type === "api_key_header");
    expect(apiKey).toBeDefined();
  });

  it("extracts baseUrl from host + basePath + schemes", async () => {
    const result = await parseSpec(jiraSwagger2);
    expect(result.baseUrl).toBe("https://your-instance.atlassian.net/rest/api/3");
  });

  it("operations have tags", async () => {
    const result = await parseSpec(jiraSwagger2);
    expect(result.operationsByTag["project"]).toBeDefined();
    expect(result.operationsByTag["issues"]).toBeDefined();
  });

  it("generates MCP server and compiles clean", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-swagger2-test-"));
    try {
      // write tool writes directly to output_dir
      const generatedDir = path.join(outDir, "generated");
      const result = await handleWriteServer({
        source: jiraSwagger2,
        output_dir: generatedDir,
        server_name: "jira-api",
        auth_type: "api_key_header",
      });

      expect(result.isError).toBeFalsy();

      const indexTs = await fs.readFile(path.join(generatedDir, "src/index.ts"), "utf8");
      const clientTs = await fs.readFile(path.join(generatedDir, "src/client.ts"), "utf8");

      expect(indexTs).toContain("get_all_projects");
      expect(clientTs).toContain("axios");

      // Install deps and typecheck
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
