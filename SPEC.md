# SPEC.md — API-to-MCP Generator: Full Implementation Spec

## What This Is
A Node.js MCP server (using stdio transport) that you install once in Claude Code or Claude Desktop. You point it at any OpenAPI 3.x spec and it writes a complete, working, typed TypeScript MCP server to disk — ready to install.

---

## 1. Dependencies

### Runtime
```json
{
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
    "ts-node": "^10.9.0"
  }
}
```

### Why each dep
- `@modelcontextprotocol/sdk` — official Anthropic MCP SDK, provides `Server`, `StdioServerTransport`, tool registration
- `@apidevtools/swagger-parser` — dereferences `$ref`, validates spec, normalises OpenAPI 3.x
- `zod` — runtime validation for THIS server's own tool inputs
- `axios` — fetch specs from URLs; also generated servers use it for HTTP calls
- `prettier` — format generated TypeScript so it's readable

---

## 2. tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 3. MCP SDK Basics (what you need to know)

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "api-to-mcp-generator", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Register tool list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "parse_openapi_spec",
      description: "Fetch and validate an OpenAPI 3.x spec from a URL or file path",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "URL (https://) or absolute file path to OpenAPI spec"
          },
          auth_header: {
            type: "string",
            description: "Optional Bearer token if spec URL requires auth"
          }
        },
        required: ["source"]
      }
    },
    // ... other tools
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case "parse_openapi_spec":
        return await handleParseSpec(args);
      // ...
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error) }],
      isError: true  // ← critical: this is how MCP signals tool errors
    };
  }
});

// Always return this shape for success:
// { content: [{ type: "text", text: JSON.stringify(result) }] }

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 4. Tool-by-Tool Spec

### Tool 1: `parse_openapi_spec`

**Input schema:**
```typescript
const ParseSpecInput = z.object({
  source: z.string().describe("URL or file path"),
  auth_header: z.string().optional()
});
```

**Logic:**
1. Detect if `source` starts with `http` → fetch via axios, write to temp file
2. Pass file path to `SwaggerParser.validate()` and `SwaggerParser.dereference()`
3. Extract: `info` (title, version, description), `servers`, list of operations
4. Each operation: `{ operationId, method, path, summary, parameters, requestBody, responses }`
5. Return summary JSON — don't return the full dereferenced spec (too large)

**Return shape:**
```json
{
  "title": "Petstore API",
  "version": "3.0.0",
  "base_url": "https://petstore.example.com/v1",
  "operation_count": 12,
  "operations": [
    {
      "operationId": "listPets",
      "method": "GET",
      "path": "/pets",
      "summary": "List all pets",
      "parameters": [...],
      "has_request_body": false,
      "response_codes": ["200", "default"]
    }
  ],
  "parse_warnings": []
}
```

**Store** the dereferenced spec in a module-level Map keyed by source, so subsequent tools don't re-fetch.

---

### Tool 2: `generate_tool_schemas`

**Input:**
```typescript
const GenerateSchemasInput = z.object({
  source: z.string(),
  operation_ids: z.array(z.string()).optional()
    .describe("If omitted, generate for all operations"),
  include_optional_params: z.boolean().default(true)
});
```

**Logic — OpenAPI → Zod codegen:**

This is the hardest part. You need to convert OpenAPI JSON Schema objects to Zod schema strings.

Key mapping table:
```
OpenAPI type     → Zod
─────────────────────────────────────────────────
string           → z.string()
string + enum    → z.enum(["a", "b", "c"])
string + format: date-time → z.string().datetime()
integer          → z.number().int()
number           → z.number()
boolean          → z.boolean()
array + items    → z.array(<recurse>)
object + props   → z.object({ key: <recurse> })
oneOf            → z.union([...])
anyOf            → z.union([...])  (approximation)
allOf            → z.intersection(...)
nullable: true   → .nullable()
not in required  → .optional()
$ref             → resolved already by swagger-parser
```

**Implementation approach** for `zod-gen.ts`:
```typescript
export function schemaToZod(schema: OpenAPIV3.SchemaObject, required = true): string {
  let zodStr = schemaToZodInner(schema);
  if (!required) zodStr += ".optional()";
  if (schema.nullable) zodStr += ".nullable()";
  if (schema.description) zodStr += `.describe(${JSON.stringify(schema.description)})`;
  return zodStr;
}

function schemaToZodInner(schema: OpenAPIV3.SchemaObject): string {
  if (schema.enum) {
    if (schema.type === "string") {
      return `z.enum([${schema.enum.map(e => JSON.stringify(e)).join(", ")}])`;
    }
    return `z.union([${schema.enum.map(e => `z.literal(${JSON.stringify(e)})`).join(", ")}])`;
  }
  switch (schema.type) {
    case "string": return "z.string()";
    case "integer": return "z.number().int()";
    case "number": return "z.number()";
    case "boolean": return "z.boolean()";
    case "array":
      return `z.array(${schema.items ? schemaToZod(schema.items as OpenAPIV3.SchemaObject) : "z.unknown()"})`;
    case "object":
      return generateObjectZod(schema);
    default:
      if (schema.oneOf) return `z.union([${schema.oneOf.map(s => schemaToZod(s as OpenAPIV3.SchemaObject)).join(", ")}])`;
      if (schema.anyOf) return `z.union([${schema.anyOf.map(s => schemaToZod(s as OpenAPIV3.SchemaObject)).join(", ")}])`;
      return "z.unknown()";
  }
}

function generateObjectZod(schema: OpenAPIV3.SchemaObject): string {
  if (!schema.properties) return "z.record(z.unknown())";
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties)
    .map(([key, val]) => `${key}: ${schemaToZod(val as OpenAPIV3.SchemaObject, required.has(key))}`)
    .join(",\n  ");
  return `z.object({\n  ${props}\n})`;
}
```

**Return shape:**
```json
{
  "schemas": [
    {
      "operation_id": "listPets",
      "tool_name": "list_pets",
      "input_schema_zod": "z.object({\n  limit: z.number().int().optional()\n})",
      "description": "List all pets"
    }
  ]
}
```

---

### Tool 3: `write_mcp_server`

**Input:**
```typescript
const WriteServerInput = z.object({
  source: z.string(),
  output_dir: z.string().describe("Absolute path to write generated server"),
  server_name: z.string(),
  base_url: z.string().optional().describe("Override base URL from spec"),
  auth_type: z.enum(["none", "bearer", "api_key_header", "api_key_query"]).default("none"),
  auth_env_var: z.string().optional().describe("Env var name for auth token"),
  operation_ids: z.array(z.string()).optional()
});
```

**Generated server structure:**
```
{output_dir}/
├── src/
│   ├── index.ts      ← main MCP server
│   └── client.ts     ← axios HTTP client with auth
├── package.json
├── tsconfig.json
└── .env.example
```

**Generated `index.ts` template** (in `templates.ts`):
```typescript
// Template function that produces the full server source
export function generateServerSource(ops: GeneratedOperation[]): string {
  return `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { client } from "./client.js";

const server = new Server(
  { name: "${serverName}", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

${ops.map(op => generateZodConst(op)).join("\n\n")}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ${ops.map(op => generateToolDefinition(op)).join(",\n    ")}
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      ${ops.map(op => generateCase(op)).join("\n      ")}
      default:
        throw new Error(\`Unknown tool: \${name}\`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: String(error) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}
```

**Write steps:**
1. Create output_dir (mkdir -p)
2. Generate and write `src/index.ts` (formatted with prettier)
3. Generate and write `src/client.ts` (axios instance with auth)
4. Write `package.json` with correct deps
5. Write `tsconfig.json`
6. Write `.env.example`
7. Return list of files written + any warnings

---

### Tool 4: `generate_mcp_config`

**Input:**
```typescript
const GenerateConfigInput = z.object({
  output_dir: z.string(),
  server_name: z.string(),
  env_vars: z.record(z.string()).optional()
});
```

**Output** `.mcp.json`:
```json
{
  "mcpServers": {
    "petstore-api": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/output_dir",
      "env": {
        "BEARER_TOKEN": "",
        "NODE_ENV": "production"
      }
    }
  }
}
```

Also writes this to `{output_dir}/.mcp.json` and returns the path + content.

---

### Tool 5: `run_validation`

**Input:**
```typescript
const ValidateInput = z.object({
  output_dir: z.string(),
  timeout_ms: z.number().default(10000)
});
```

**Steps:**
1. Run `npm install` in output_dir (spawn)
2. Run `npx tsc --noEmit` — capture stdout/stderr
3. Spawn the server with stdio transport
4. Send MCP `initialize` request + `tools/list` request via JSON-RPC
5. Verify response matches expected schema
6. Kill server process
7. Return validation report

**Return shape:**
```json
{
  "passed": true,
  "checks": [
    { "name": "npm_install", "passed": true },
    { "name": "typescript_compile", "passed": true, "output": "" },
    { "name": "server_starts", "passed": true },
    { "name": "tools_list", "passed": true, "tool_count": 5 }
  ],
  "errors": []
}
```

---

### Tool 6: `generate_readme`

**Input:**
```typescript
const GenerateReadmeInput = z.object({
  source: z.string(),
  output_dir: z.string(),
  server_name: z.string()
});
```

**Generates** a README.md with:
- What the server does
- Installation steps (`npm install && npm run build`)
- MCP config snippet
- List of all tools with their parameters
- Auth setup instructions
- Example usage with Claude

Writes to `{output_dir}/README.md` and returns the content.

---

## 5. Error Handling Patterns

```typescript
// Every tool handler should follow this pattern:
async function handleTool(args: unknown) {
  try {
    const parsed = InputSchema.parse(args);  // Zod parse — throws ZodError
    const result = await doWork(parsed);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    const message = error instanceof ZodError 
      ? `Invalid input: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`
      : error instanceof Error 
        ? error.message 
        : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true
    };
  }
}
```

---

## 6. Testing Strategy

Use `vitest`. Three test files:

**`tests/parse.test.ts`** — test spec parsing with fixture files
```typescript
import { describe, it, expect } from "vitest";
import { parseSpec } from "../src/tools/parse";

describe("parseSpec", () => {
  it("parses petstore spec from file", async () => {
    const result = await parseSpec({ source: "./tests/fixtures/petstore.yaml" });
    expect(result.operation_count).toBeGreaterThan(0);
    expect(result.operations[0]).toHaveProperty("operationId");
  });
});
```

**`tests/zod-gen.test.ts`** — unit test every schema type conversion
```typescript
it("converts string enum to z.enum", () => {
  const schema = { type: "string", enum: ["foo", "bar"] };
  expect(schemaToZod(schema)).toBe('z.enum(["foo", "bar"])');
});
```

**Fixtures:** Download petstore.yaml and a more complex spec (stripe or github) to `tests/fixtures/`.

---

## 7. The `.mcp.json` for THIS Server

```json
{
  "mcpServers": {
    "api-to-mcp-generator": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/api-to-mcp-generator"
    }
  }
}
```

Put this in your project root or `~/.claude/` to use this server in Claude Code.

---

## 8. Edge Cases to Handle

| Situation | Handling |
|-----------|----------|
| No operationId in spec | Generate from method + path: `GET /pets/{id}` → `get_pets_by_id` |
| Circular $ref | swagger-parser handles this; catch and return warning |
| Very large specs (200+ endpoints) | Add `operation_ids` filter, warn if >50 ops without filter |
| Auth on spec URL | Accept `auth_header` param in parse_openapi_spec |
| Windows paths | Use `path.resolve()` everywhere, never string concat |
| output_dir already exists | Check for existing files, warn but don't overwrite without confirmation |

---

## 9. Demo Script for the Application

Show this workflow:
```bash
# 1. Start the server
node dist/index.js

# 2. In Claude Code (after installing via .mcp.json):
# "Parse the Petstore spec from https://petstore3.swagger.io/api/v3/openapi.yaml"
# "Generate tool schemas for listPets and createPets"  
# "Write the MCP server to ~/generated-mcp/petstore"
# "Run validation on ~/generated-mcp/petstore"
# "Generate the MCP config"
# "Generate the README"

# 3. Show the generated server:
cat ~/generated-mcp/petstore/src/index.ts
# Then: node ~/generated-mcp/petstore/dist/index.js
```
