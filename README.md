# api-to-mcp-generator

A meta-MCP: an MCP server that reads any OpenAPI 3.x spec and generates a complete, production-ready TypeScript MCP server — with Zod schemas, auth injection, config, and documentation.

Point it at any REST API spec. Get a working MCP server in under a minute.

## What it does

```
OpenAPI 3.x spec (URL or file)
  → Normalized IR (NormalizedOperation[])
    → TypeScript MCP server with:
        - Zod-validated tool inputs
        - axios HTTP client with auth injection
        - .mcp.json config for Claude Desktop / Claude Code
        - Generation manifest for reproducibility
        - README
```

## Installation

```bash
git clone https://github.com/Arjun0014/api-to-mcp-generator
cd api-to-mcp-generator
npm install
npm run build
```

Add to your `.mcp.json` or Claude Desktop config:

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

## Tools

| Tool | What it does |
|------|-------------|
| `parse_openapi_spec` | Fetch + validate an OpenAPI 3.x spec. Returns operations grouped by tag, detected auth schemes, spec hash. |
| `generate_tool_schemas` | Preview Zod input schemas per operation — inspect before generating. |
| `write_mcp_server` | Generate and write the full TypeScript MCP server to disk. Supports `dry_run`, `force`, auth auto-detection. |
| `generate_mcp_config` | Write `.mcp.json` for Claude Desktop or Claude Code. |
| `run_validation` | Compile + start the generated server + probe it with MCP `initialize`/`tools/list`. |
| `generate_readme` | Write a README for the generated server. |

## Example workflow (in Claude)

```
"Parse the Petstore spec from tests/fixtures/petstore.yaml"
→ returns 5 operations in 2 tag groups, no auth detected

"Write the MCP server to ~/generated/petstore with server_name petstore-api"
→ writes src/index.ts, src/client.ts, package.json, tsconfig.json, manifest, .env.example

"Run validation on ~/generated/petstore"
→ npm install → tsc clean → MCP probe: 5 tools registered ✓

"Generate the MCP config"
→ writes .mcp.json

"Generate the README"
→ writes README.md with tool list, auth setup, MCP config snippet
```

## Source input format

All tools that accept a spec source use an explicit typed union — no string inference:

```json
{ "type": "url",  "url": "https://api.example.com/openapi.json" }
{ "type": "file", "path": "./specs/myapi.yaml" }
```

URL sources: HTTPS only, SSRF-protected (IPv4 + IPv6 blocklist).
File sources: path traversal protected (Unix `/etc` + Windows `C:\Windows` blocked).

## Auth support

Auth is auto-detected from OpenAPI `securitySchemes`. Supported:

| Scheme | Env var | Injection |
|--------|---------|-----------|
| `http: bearer` | `BEARER_TOKEN` | `Authorization: Bearer $TOKEN` header |
| `apiKey: header` | `API_KEY_HEADER` | custom header |
| `apiKey: query` | `API_KEY_QUERY` | query param |

## Architecture

```
src/
├── ir/types.ts         — NormalizedOperation, NormalizedSchema discriminated union
├── security/guards.ts  — validateSourceUrl() + validateOutputDir()
├── cache.ts            — session-scoped SHA-256-keyed IR cache
├── codegen/
│   ├── normalizer.ts   — OpenAPI → IR (dispatcher + per-type helpers)
│   └── emitters/
│       ├── index.ts    — emit(ir, "mcp", ctx) protocol-agnostic interface
│       └── mcp.ts      — MCPEmitter: IR → TypeScript source
└── tools/              — 6 MCP tool handlers
```

The IR layer is a correctness mechanism, not a template system. It normalizes every OpenAPI schema type (string/enum/array/object/oneOf/anyOf/allOf/nullable/circular) once, so every tool inherits correct output.

## Limitations (v1)

- OpenAPI 3.x only (no Swagger 2.0)
- No OAuth flows
- No streaming responses
- No file upload endpoints
- `allOf` with discriminator → `z.unknown()` + warning (manual review needed)

## Development

```bash
npm test          # vitest (77 tests)
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/
```

## License

MIT
