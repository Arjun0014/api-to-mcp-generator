# QUICKREF.md — Key Snippets & Gotchas

## The MCP Tool Response Contract

Every tool handler MUST return one of these two shapes. Never throw.

```typescript
// Success
return {
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
};

// Error  
return {
  content: [{ type: "text" as const, text: errorMessage }],
  isError: true
};
```

---

## package.json (exact)

```json
{
  "name": "api-to-mcp-generator",
  "version": "1.0.0",
  "description": "Generate TypeScript MCP servers from OpenAPI specs",
  "main": "dist/index.js",
  "type": "commonjs",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@apidevtools/swagger-parser": "^10.1.0",
    "zod": "^3.22.0",
    "axios": "^1.6.0",
    "prettier": "^3.2.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0",
    "ts-node": "^10.9.0",
    "@vitest/coverage-v8": "^1.2.0"
  }
}
```

---

## The .mcp.json to install THIS server

Put in your project root:
```json
{
  "mcpServers": {
    "api-to-mcp-generator": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/ABSOLUTE/PATH/TO/api-to-mcp-generator"
    }
  }
}
```

Or for Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`

---

## swagger-parser usage

```typescript
import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";

// Dereference: resolves all $ref inline (critical before codegen)
const api = await SwaggerParser.dereference(specPath) as OpenAPIV3.Document;

// Validate: checks spec is valid (run this too for user feedback)
await SwaggerParser.validate(specPath);

// api.paths["GET /pets"] won't work — iterate:
for (const [path, pathItem] of Object.entries(api.paths ?? {})) {
  for (const method of ["get","post","put","delete","patch"] as const) {
    const operation = pathItem?.[method];
    if (operation) {
      // operation.operationId, operation.summary, operation.parameters, etc.
    }
  }
}
```

---

## Spawning the generated server for validation

```typescript
import { spawn } from "child_process";
import { createInterface } from "readline";

async function probeGeneratedServer(serverPath: string): Promise<ValidationResult> {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: serverPath,
    stdio: ["pipe", "pipe", "pipe"]
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 5000);

    // MCP uses newline-delimited JSON over stdio
    const rl = createInterface({ input: proc.stdout });
    let initialized = false;
    
    // Send initialize request
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "validator", version: "1.0.0" }
      }
    });
    
    proc.stdin.write(initRequest + "\n");

    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1 && !initialized) {
          initialized = true;
          // Send tools/list
          proc.stdin.write(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
          }) + "\n");
        } else if (msg.id === 2) {
          clearTimeout(timeout);
          proc.kill();
          resolve({
            passed: true,
            tool_count: msg.result?.tools?.length ?? 0
          });
        }
      } catch {}
    });

    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}
```

---

## Path safety (prevent path traversal)

```typescript
import path from "path";

function validateOutputDir(outputDir: string): string {
  const resolved = path.resolve(outputDir);
  // Disallow anything that looks like a home dir escape or system path
  const forbidden = ["/etc", "/usr", "/bin", "/sbin", "/root", "/private"];
  if (forbidden.some(f => resolved.startsWith(f))) {
    throw new Error(`Unsafe output directory: ${resolved}`);
  }
  return resolved;
}

function validateSourceUrl(source: string): void {
  if (source.startsWith("http")) {
    const url = new URL(source); // throws if invalid
    // Block SSRF targets
    const blocked = ["169.254.", "10.", "172.16.", "192.168.", "localhost", "127."];
    if (blocked.some(b => url.hostname.startsWith(b) || url.hostname === "localhost")) {
      throw new Error(`Blocked URL (SSRF protection): ${url.hostname}`);
    }
  }
}
```

---

## operationId → tool name conversion

OpenAPI operationIds are often camelCase. MCP tool names should be snake_case.

```typescript
function toToolName(operationId: string, method: string, path: string): string {
  if (operationId) {
    // camelCase → snake_case
    return operationId.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
  }
  // Fallback: GET /pets/{id} → get_pets_by_id
  const cleanPath = path
    .replace(/\{(\w+)\}/g, "by_$1")
    .replace(/\//g, "_")
    .replace(/^_/, "");
  return `${method}_${cleanPath}`.toLowerCase();
}
```

---

## vitest config (add to package.json)

```json
"vitest": {
  "include": ["tests/**/*.test.ts"],
  "coverage": {
    "provider": "v8",
    "include": ["src/**/*.ts"],
    "thresholds": { "lines": 80 }
  }
}
```

---

## Common Gotchas

1. **`type: "text" as const`** — TypeScript won't infer the literal type without this
2. **`await server.connect(transport)` must be the last line** — it blocks until connection closes
3. **swagger-parser mutates the input** — always pass the file path, not a pre-parsed object
4. **prettier.format() is async** — `await prettier.format(code, { parser: "typescript" })`
5. **Generated package.json needs `"type": "commonjs"`** — MCP SDK uses CommonJS
6. **Don't use ESM in generated servers** — stick to CommonJS for maximum compatibility
7. **operationIds with slashes or spaces** — sanitize before using as variable names
8. **Required vs optional parameters** — OpenAPI `required: ["field"]` is on the PARENT object, not the property itself
