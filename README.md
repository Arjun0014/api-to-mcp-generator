# api-to-mcp-generator

> A compiler pipeline that turns any OpenAPI 3.x spec into a production-ready TypeScript MCP server — with Zod validation, auth injection, MCP config, and end-to-end probe validation.

Point it at any REST API spec. Get a working, Claude-ready MCP server in under a minute.

```
OpenAPI 3.x spec (URL or file)
  → Normalized IR (NormalizedOperation[])
    → TypeScript MCP server
        ├── Zod-validated tool inputs
        ├── axios HTTP client with auth injection
        ├── .mcp.json for Claude Desktop / Claude Code
        ├── Generation manifest (provenance + reproducibility)
        └── README
```

---

## Why this exists

Most OpenAPI → MCP converters are template dumps. They take an endpoint, rename it, and call it a tool. That breaks on real-world specs: `oneOf`, `allOf`, nullable fields, circular refs, missing `operationId`s, path params vs query params vs body — all produce silent failures or malformed schemas.

This generator uses an **intermediate representation layer**. Every OpenAPI schema type normalises once into `NormalizedOperation[]`, and every downstream tool — Zod schema generation, TypeScript codegen, validation — works off that single correct IR. The result is deterministic output regardless of how messy the source spec is.

It also guards against the biggest LLM usability failure: generating 400 tools from a large API. Claude can't reason over 400 tools. This generator warns at 50, refuses at 100, and supports tag-based filtering so you work with the slice of the API you actually need.

---

## Installation

```bash
git clone https://github.com/Arjun0014/api-to-mcp-generator
cd api-to-mcp-generator
npm install
npm run build
```

Then register it as an MCP server. In your `.mcp.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop):

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

---

## The 6-tool pipeline

Each tool is independently useful. You can parse without generating, preview schemas without writing files, or run validation on an already-generated server.

### `parse_openapi_spec`

Fetches and validates an OpenAPI 3.x spec, dereferences all `$ref` links, normalises every operation into a structured summary, and groups them by tag. The parsed IR is cached by spec hash — subsequent tool calls for the same spec hit the cache, not the network.

```json
{
  "source": { "type": "file", "path": "./tests/fixtures/petstore.yaml" }
}
```

Returns:

```json
{
  "title": "Petstore",
  "operationCount": 5,
  "operationsByTag": {
    "pets":   ["list_pets", "create_pets", "show_pet_by_id", "delete_pet"],
    "owners": ["list_owners"]
  },
  "detectedAuthSchemes": [],
  "specHash": "283a89067e..."
}
```

`operationsByTag` lets you filter large specs before generating. `specHash` is a SHA-256 of the raw spec bytes — the key for session-scoped caching and the provenance record in the manifest.

---

### `generate_tool_schemas`

Converts OpenAPI schemas to Zod validation strings per operation. Use this to inspect what input validation will look like before committing to a full server. Also useful if you already have an MCP server and want to pull in just the schemas.

```json
{
  "source": { "type": "file", "path": "./tests/fixtures/petstore.yaml" },
  "operation_ids": ["listPets", "createPets"]
}
```

Returns:

```json
{
  "schemas": [
    {
      "operation_id": "listPets",
      "tool_name": "list_pets",
      "input_schema_zod": "z.object({\n  limit: z.number().int().optional(),\n  tags: z.array(z.string()).optional()\n})"
    },
    {
      "operation_id": "createPets",
      "tool_name": "create_pets",
      "input_schema_zod": "z.object({\n  body: z.object({\n    name: z.string(),\n    tag: z.string().optional()\n  })\n})"
    }
  ]
}
```

Notice: `limit` maps to `z.number().int()` (not `z.number()`), `tag` is `.optional()` because the OpenAPI `required` array only lists `name`, and path params are always required. These are correctness details that template-based generators get wrong.

---

### `write_mcp_server`

Generates and writes the full TypeScript MCP server to disk. Supports `dry_run` to preview the file list before committing, and `force` to overwrite an existing output directory intentionally.

```json
{
  "source": { "type": "file", "path": "./tests/fixtures/petstore.yaml" },
  "output_dir": "~/generated-mcp/petstore",
  "server_name": "petstore-api",
  "dry_run": true
}
```

Files written:

| File | What it is |
|------|-----------|
| `src/index.ts` | The MCP server — tools registered, Zod schemas, HTTP dispatch |
| `src/client.ts` | axios client pre-configured with base URL and auth injection |
| `package.json` | Ready to `npm install` |
| `tsconfig.json` | Strict TypeScript config |
| `.env.example` | Auth token placeholder (populated when auth is detected) |
| `.mcp-generator-manifest.json` | Provenance record — spec hash, generated tools, options |

The manifest is the contract between generation and consumption. Tools 4, 5, and 6 read it instead of re-parsing the spec — which means README and config generation are reproducible independently of the original spec.

**Collision protection:** running `write_mcp_server` twice returns `isError: true` listing conflicting files. Use `dry_run: true` to preview, then `force: true` to overwrite intentionally.

**Op count guard:** specs with more than 50 operations produce a warning. Specs with more than 100 refuse generation entirely. Use `operation_ids` or tag filtering to select the relevant slice.

---

### `generate_mcp_config`

Writes the `.mcp.json` config so Claude Code or Claude Desktop can install and run the generated server. Reads the manifest to auto-populate `env` blocks for any detected auth schemes.

```json
{
  "output_dir": "~/generated-mcp/petstore",
  "server_name": "petstore-api"
}
```

For a spec with no auth:

```json
{
  "mcpServers": {
    "petstore-api": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/generated-mcp/petstore"
    }
  }
}
```

For a spec with Bearer auth, the `env` block is added automatically:

```json
{
  "mcpServers": {
    "petstore-api": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/generated-mcp/petstore",
      "env": { "BEARER_TOKEN": "" }
    }
  }
}
```

No manual wiring. The manifest told `generate_mcp_config` exactly which env var to use.

---

### `run_validation`

The end-to-end correctness check. Compiles the generated server with `tsc`, builds it, starts it as a child process, then sends it a real MCP `initialize` request followed by `tools/list`. Reports per-phase timing.

```json
{ "output_dir": "~/generated-mcp/petstore" }
```

Output:

```json
{
  "passed": true,
  "tool_count": 5,
  "tools": ["list_pets", "create_pets", "show_pet_by_id", "delete_pet", "list_owners"],
  "checks": [
    { "name": "typescript_compile", "passed": true, "elapsedMs": 812 },
    { "name": "server_starts",      "passed": true, "elapsedMs": 420 },
    { "name": "tools_list",         "passed": true, "elapsedMs": 580, "output": "5 tool(s) registered" }
  ]
}
```

This is not just `tsc --noEmit`. The server is actually spawned and probed with live MCP protocol messages. If `tools/list` returns 5 tools, the server speaks MCP correctly.

---

### `generate_readme`

Writes a README for the generated server. Reads the manifest — no re-parsing the spec required.

```json
{
  "output_dir": "~/generated-mcp/petstore",
  "server_name": "petstore-api"
}
```

---

## Auth support

Auth is auto-detected from OpenAPI `securitySchemes`. Three schemes are supported:

| Scheme | Env var | Injection point |
|--------|---------|-----------------|
| `http: bearer` | `BEARER_TOKEN` | `Authorization: Bearer $TOKEN` header |
| `apiKey: header` | `API_KEY_HEADER` | custom header |
| `apiKey: query` | `API_KEY_QUERY` | query parameter |

Auth flows through three places automatically: `parse_openapi_spec` detects the scheme, `write_mcp_server` injects it into `src/client.ts`, and `generate_mcp_config` adds the `env` block. You set the env var — the generator handles the wiring.

OAuth flows are not yet supported.

---

## Security

**URL sources** — HTTPS only. IPv4 and IPv6 SSRF blocklists applied. Redirect-following disabled.

**File sources** — Path traversal protection. Unix `/etc` and Windows `C:\Windows` system paths are blocked. Output directory must be within home or working directory.

**Op count guard** — Refuses to generate servers with more than 100 tools. Warns at 50. Prevents generating an MCP server that Claude cannot reason over.

---

## Architecture

```
src/
├── ir/types.ts           — NormalizedOperation, NormalizedSchema discriminated union
├── security/guards.ts    — validateSourceUrl(), validateOutputDir()
├── cache.ts              — session-scoped SHA-256-keyed IR cache
├── codegen/
│   ├── normalizer.ts     — OpenAPI → IR (dispatcher + per-type helpers)
│   └── emitters/
│       ├── index.ts      — emit(ir, "mcp", ctx) protocol-agnostic interface
│       └── mcp.ts        — MCPEmitter: IR → TypeScript source
└── tools/                — 6 MCP tool handlers
```

The IR layer is the core correctness mechanism. It normalises every OpenAPI schema variant — `string`, `enum`, `array`, `object`, `oneOf`, `anyOf`, `allOf`, `nullable`, circular refs — once, in one place. Everything downstream inherits correct output without knowing about OpenAPI at all.

The emitter interface (`emit(ir, "mcp", ctx)`) is protocol-agnostic by design. Adding a new target (LangChain tools, Vertex AI functions) means writing a new emitter — not touching the normalizer or the tool handlers.

---

## Limitations (v1)

| Limitation | Detail |
|-----------|--------|
| OpenAPI 3.x only | No Swagger 2.0 support |
| No OAuth | Bearer token and API key only |
| No streaming responses | Synchronous HTTP only |
| No file upload endpoints | `multipart/form-data` not supported |
| `allOf` with discriminator | Emits `z.unknown()` with a warning — manual review needed |

---

## Development

```bash
npm test          # vitest (77 tests)
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/
```

---

## What's next

- OAuth 2.0 support (authorization code + client credentials)
- Swagger 2.0 / OpenAPI 2.x normaliser
- Tag-based filtering in `write_mcp_server` (generate a subset by tag, not just by operation ID)
- Streaming response support
- Claude-assisted tool selection (use the LLM to pick the relevant operations from a large spec)

---

## License

MIT
