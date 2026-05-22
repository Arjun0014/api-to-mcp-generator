# api-to-mcp-generator

**Turn any REST API into a Claude-ready MCP server in under 60 seconds.**

No template dumping. No manual tool definitions. A proper compiler pipeline — normalised IR, strict TypeScript, Zod validation, auto-detected auth — that works on the APIs you actually encounter in the field: Stripe, Jira, Salesforce, HubSpot.

```
OpenAPI 3.x / Swagger 2.0 spec  →  Normalised IR  →  TypeScript MCP server
       (URL or file)                    (IR cache)        (tsc-clean, Claude-ready)
```

[![CI](https://github.com/Arjun0014/api-to-mcp-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/Arjun0014/api-to-mcp-generator/actions/workflows/ci.yml)

---

## The problem

Every time a Forward Deployed Engineer onboards a client API for a Claude integration, they write the same boilerplate: MCP tool definitions, Zod input schemas, axios client with auth injection, `.mcp.json` config. For a 20-endpoint API that's half a day. For Stripe's 400+ endpoints it's a week.

Template-based generators exist but they break on real-world specs. `oneOf` becomes `z.unknown()`. Circular `$ref` schemas crash. Missing `operationId`s produce collisions. Nullable fields get dropped. Auth wiring is left to the developer.

**This is a compiler, not a template.** Every OpenAPI schema variant normalises once into a typed IR (`NormalizedOperation[]`). Everything downstream — Zod schemas, TypeScript codegen, validation, README — works off that single correct representation. The result is deterministic output that compiles clean and passes a live MCP protocol probe.

---

## What's different in V2

V1 worked on clean specs. V2 works on enterprise APIs.

| Problem | V1 | V2 |
|---------|----|----|
| Stripe has 400+ endpoints | Hard refuses at >100 | `groupingRecommendation` splits by tag; `tag` filter generates one group |
| Circular `$ref` schemas | Falls back to `z.unknown()` | Emits proper `z.lazy(() => CategorySchema)` |
| Jira / Salesforce are Swagger 2.0 | Rejects the spec | Native adapter — `definitions`, `basePath`, `x-nullable`, `securityDefinitions` |
| HubSpot / Salesforce use OAuth M2M | Warning only | Generated `client.ts` auto-fetches tokens with `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` |
| Re-parsing the same spec on every call | Second `dereference()` on cache hit | IR cached with metadata; `operationsByTag` computed from `op.tags` inline |

---

## How it works

```
                         ┌─────────────────────────────────────────────────────┐
                         │              api-to-mcp-generator                    │
                         │                                                       │
  OpenAPI 3.x ──────────►│  validateSourceUrl()  ──►  SwaggerParser.dereference │
  Swagger 2.0 ──────────►│  (SSRF + size guards)      (resolves all $refs)      │
  (URL or file)          │              │                                        │
                         │              ▼                                        │
                         │   normalizeDoc()  ◄─── version detection             │
                         │      │                                                │
                         │      ├─ normalizeSpec()       ← OpenAPI 3.x path     │
                         │      └─ normalizeSwagger2Doc() ← Swagger 2.0 path    │
                         │              │                                        │
                         │              ▼                                        │
                         │   NormalizedOperation[]  +  namedSchemas             │
                         │   (IR: typed, deduplicated, tag-annotated)           │
                         │              │                                        │
                         │    SHA-256-keyed session cache                       │
                         │              │                                        │
                         │              ▼                                        │
                         │   MCPEmitter.emit(ir, "mcp", ctx)                   │
                         │      │                                                │
                         │      ├─ buildIndexTs()   → src/index.ts              │
                         │      │    Zod schemas, tool defs, HTTP dispatch      │
                         │      ├─ buildClientTs()  → src/client.ts             │
                         │      │    Bearer / API key / OAuth clientCredentials  │
                         │      └─ package.json, tsconfig.json, .mcp.json       │
                         └─────────────────────────────────────────────────────┘

  Generated server output:
  ┌───────────────────────────────────────────────────────┐
  │  src/index.ts       MCP server — tools + dispatch     │
  │  src/client.ts      axios client + auth injection     │
  │  package.json       ready to npm install              │
  │  tsconfig.json      strict TypeScript                 │
  │  .env.example       auth env var placeholders         │
  │  .mcp.json          Claude Desktop / Claude Code      │
  │  .mcp-generator-manifest.json  provenance record      │
  └───────────────────────────────────────────────────────┘
```

### The IR layer

The normalizer is the heart of the compiler. Every OpenAPI schema variant maps to one of these IR kinds:

```typescript
type NormalizedSchema =
  | { kind: "string";       enum?: string[]; format?: string; nullable: boolean }
  | { kind: "number";       integer: boolean; nullable: boolean }
  | { kind: "boolean";      nullable: boolean }
  | { kind: "array";        items: NormalizedSchema; nullable: boolean }
  | { kind: "object";       properties: Record<string, { schema: NormalizedSchema; required: boolean }>; nullable: boolean }
  | { kind: "union";        variants: NormalizedSchema[]; nullable: boolean }   // oneOf / anyOf
  | { kind: "intersection"; parts: NormalizedSchema[] }                          // allOf
  | { kind: "lazy";         refName: string }                                    // circular → z.lazy()
  | { kind: "unknown";      warning: string };                                   // unnormalisable
```

`oneOf` becomes `z.union()`. `allOf` becomes `z.intersection()`. Circular schemas become `z.lazy()`. Nullable fields get `.nullable()`. Every OpenAPI schema quirk is handled once — the emitter just switches on `kind`.

### Session cache

```
First call:  fetchSpec → dereference → normalize → setCachedIR(specHash, ir, namedSchemas, metadata)
             ~2-30 seconds (network + swagger-parser)

Subsequent:  getCachedEntry(specHash) → { ir, namedSchemas, metadata }
             <1ms — no network, no re-parsing
```

The cache key is SHA-256 of the raw spec bytes. Same URL, same bytes → same cache hit. Different bytes (spec updated) → cache miss and re-normalize automatically.

---

## Quick start

```bash
git clone https://github.com/Arjun0014/api-to-mcp-generator
cd api-to-mcp-generator
npm install && npm run build
```

Register as an MCP server in Claude Code (`.mcp.json`) or Claude Desktop (`claude_desktop_config.json`):

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

## Tools

### `parse_openapi_spec`

Fetches, validates, dereferences, and normalises a spec. Groups operations by tag. Detects auth schemes. For large specs (>100 operations), returns a `groupingRecommendation` — the tag groups, operation counts, and suggested server names — so you can decide which slice to generate.

**Input:**
```json
{
  "source": { "type": "url", "url": "https://petstore.swagger.io/v2/swagger.json" }
}
```

**Output (small spec):**
```json
{
  "title": "Swagger Petstore",
  "version": "1.0.7",
  "operationCount": 20,
  "operationsByTag": {
    "pet":   [{ "toolName": "add_pet", "method": "post", "path": "/pet" }, "..."],
    "store": ["..."],
    "user":  ["..."]
  },
  "detectedAuthSchemes": [{ "type": "api_key_header", "envVar": "API_KEY_HEADER" }],
  "specHash": "a3f8e2...",
  "warnings": []
}
```

**Output (large spec, >100 ops):**
```json
{
  "operationCount": 412,
  "groupingRecommendation": {
    "strategy": "generate_by_tag",
    "groups": [
      { "tag": "charges",   "count": 15, "suggestedServer": "stripe-charges"   },
      { "tag": "customers", "count": 12, "suggestedServer": "stripe-customers" },
      { "tag": "products",  "count": 9,  "suggestedServer": "stripe-products"  }
    ],
    "totalGroups": 38,
    "fitsInOneServer": false
  }
}
```

Claude reads this and says: *"This spec has 38 groups. Which do you need? I'll generate servers for those."*

---

### `write_mcp_server`

Generates and writes the full TypeScript MCP server to disk. Writes atomically (temp dir → rename) — no partial output.

**Input:**
```json
{
  "source":      { "type": "url", "url": "https://petstore.swagger.io/v2/swagger.json" },
  "output_dir":  "~/generated/petstore-pet",
  "server_name": "petstore-pet",
  "tag":         "pet",
  "dry_run":     true
}
```

| Parameter | Description |
|-----------|-------------|
| `tag` | Generate only operations from this tag group. Mutually exclusive with `operation_ids`. |
| `operation_ids` | Generate specific operations by ID or tool name. |
| `auth_type` | Override detected auth: `bearer`, `api_key_header`, `api_key_query`, `oauth_client_credentials`. |
| `dry_run` | Return file contents without writing to disk. |
| `force` | Overwrite existing files. Bypasses collision check only — never bypasses security guards. |

**Files written:**

| File | Description |
|------|-------------|
| `src/index.ts` | MCP server: Zod-validated tools, `CallToolRequestSchema` handler, `stdio` transport |
| `src/client.ts` | axios client: base URL + auth injection (or OAuth token fetcher) |
| `package.json` | Dependencies, build scripts |
| `tsconfig.json` | Strict TypeScript, CommonJS output |
| `.env.example` | Auth env var placeholders |
| `.mcp.json` | Ready to paste into Claude config |
| `.mcp-generator-manifest.json` | Provenance: spec hash, generated tools, options, timestamp |

**Example — generated Zod schema for a real endpoint:**

```typescript
// Generated from OpenAPI: GET /pets?limit=&tags[]=
const list_petsSchema = z.object({
  limit: z.number().int().optional(),
  tags:  z.array(z.string()).optional(),
});
```

Notice: `limit` is `.int()` (not just `z.number()`), `tags` is `z.array(z.string())` (not `z.string()`). These details come from the IR normalizer — template generators get them wrong.

---

### `generate_tool_schemas`

Preview Zod schemas without generating a full server. Useful for inspecting normalisation output or pulling schemas into an existing MCP server.

```json
{
  "source":       { "type": "file", "path": "./tests/fixtures/petstore.yaml" },
  "operation_ids": ["listPets", "createPets"]
}
```

---

### `generate_mcp_config`

Writes `.mcp.json` from the generation manifest. Auto-populates `env` blocks for detected auth.

```json
{
  "mcpServers": {
    "stripe-charges": {
      "command": "node",
      "args":    ["dist/index.js"],
      "cwd":     "/Users/you/generated/stripe-charges",
      "env":     { "BEARER_TOKEN": "" }
    }
  }
}
```

No manual wiring. The manifest told `generate_mcp_config` which env var to use.

---

### `run_validation`

End-to-end correctness check. Runs `tsc --noEmit`, builds the server, spawns it as a child process, and probes it with live MCP `initialize` + `tools/list` messages.

```json
{
  "output_dir": "~/generated/petstore-pet"
}
```

```json
{
  "passed": true,
  "toolCount": 8,
  "tools": ["add_pet", "update_pet", "find_pets_by_status", "..."],
  "checks": [
    { "name": "typescript_compile", "passed": true, "elapsedMs": 812 },
    { "name": "server_starts",      "passed": true, "elapsedMs": 420 },
    { "name": "tools_list",         "passed": true, "elapsedMs": 580, "output": "8 tool(s)" }
  ]
}
```

This isn't just `tsc --noEmit`. The server is spawned and speaks MCP protocol. If `tools/list` returns 8 tools, the server works.

---

### `generate_readme`

Writes a README for the generated server from the manifest. No re-parsing the spec.

---

## Auth support

Auth is auto-detected from `securitySchemes`. Four schemes are supported:

| Scheme | Env var | Generated injection |
|--------|---------|---------------------|
| `http: bearer` | `BEARER_TOKEN` | `Authorization: Bearer $TOKEN` |
| `apiKey: header` | `API_KEY_HEADER` | custom header name from spec |
| `apiKey: query` | `API_KEY_QUERY` | query parameter name from spec |
| OAuth 2.0 `clientCredentials` | `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` | auto token fetch + refresh |

**OAuth client credentials — what gets generated:**

For specs with `flows.clientCredentials` (Salesforce, HubSpot, enterprise APIs), the generated `client.ts` includes a full token fetcher with caching:

```typescript
// Generated client.ts — auto token fetch + refresh
const TOKEN_ENDPOINT = process.env.OAUTH_TOKEN_ENDPOINT ?? "https://auth.example.com/token";

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;  // cached
  }
  const res = await axios.post(TOKEN_ENDPOINT, {
    grant_type:    "client_credentials",
    client_id:     process.env.OAUTH_CLIENT_ID,
    client_secret: process.env.OAUTH_CLIENT_SECRET,
  });
  tokenCache = { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return tokenCache.token;
}

// Every API call gets a fresh (or cached) token automatically
client.interceptors.request.use(async (config) => {
  config.headers.Authorization = `Bearer ${await getToken()}`;
  return config;
});
```

Set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`. The generated server handles the rest.

> **`authorizationCode` OAuth is intentionally excluded.** That flow requires a browser redirect and user consent screen — incompatible with a headless stdio MCP process. For user-scoped API tokens, paste them as `BEARER_TOKEN` (already supported).

---

## Swagger 2.0 support

Swagger 2.0 specs (Jira Cloud, older Salesforce, many internal enterprise APIs) parse cleanly via a native adapter — no external converter, no new dependencies.

```
doc.swagger === "2.0"
  → normalizeSwagger2Doc()
      ├── definitions        → components/schemas equivalent
      ├── basePath + host    → baseUrl
      ├── x-nullable: true   → nullable: true
      ├── responses[N].schema → (no content wrapper)
      └── securityDefinitions
            └── flow: "application" → oauth_client_credentials

doc.openapi.startsWith("3.")
  → normalizeSpec()  ← unchanged V1 path
```

Both paths produce identical `NormalizedOperation[]` IR. Everything downstream — emitter, validation, readme — is unchanged.

---

## Security model

| Concern | Mitigation |
|---------|------------|
| SSRF via URL specs | HTTPS-only. IPv4 + IPv6 blocklists (RFC1918, link-local, loopback, mapped). Redirects disabled. |
| Path traversal via output_dir | `validateOutputDir()` blocks system paths, requires home/cwd. |
| Path traversal via file specs | `validateFilePath()` blocks system paths. |
| Code injection via schema names | `VALID_IDENTIFIER` check before embedding schema keys as TypeScript identifiers. |
| Spec size bombs | 10MB raw limit. 25MB dereferenced limit (catches `$ref` expansion). |
| OAuth token endpoint SSRF | `validateSourceUrl()` applied to `tokenUrl` at codegen time. Invalid URL → empty default + warning. |
| Prompt injection via spec descriptions | Warning emitted when spec is URL-sourced. Tool descriptions come directly from the spec — review before installing generated servers from untrusted sources. |
| Unfiltered large specs | 100-operation write guard. Lifted when `tag` or `operation_ids` scopes the request. |

---

## Architecture

```
src/
├── ir/
│   └── types.ts               NormalizedSchema (discriminated union), NormalizedOperation,
│                              NormCtx (WeakSet ancestor tracking + WeakMap component names)
├── security/
│   └── guards.ts              validateSourceUrl() — SSRF (IPv4+IPv6)
│                              validateOutputDir() — path traversal (Unix+Windows)
│                              checkRawSize(), checkDereferencedSize()
├── cache.ts                   SHA-256-keyed session cache
│                              CacheEntry: { ir, namedSchemas, metadata, parsedAt }
├── codegen/
│   ├── normalizer.ts          normalizeDoc() — version dispatcher
│   │                          normalizeSpec() — OpenAPI 3.x (two-pass: components then paths)
│   │                          normalizeSwagger2Doc() — Swagger 2.0 adapter
│   │                          normalizeSchema() — WeakSet cycle detection → z.lazy()
│   ├── templates.ts           String fragments (generated file header, .env, package.json)
│   └── emitters/
│       ├── index.ts           emit(ir, "mcp", ctx) — protocol-agnostic interface
│       │                      EmitterContext: baseUrl, serverName, authType, tokenEndpoint, namedSchemas
│       └── mcp.ts             MCPEmitter: IR → TypeScript
│                              buildIndexTs() — Zod schemas, tool defs, MCP handler
│                              buildClientTs() — axios client or OAuth token fetcher
│                              buildLazyConsts() — hoists z.lazy() named schema consts
└── tools/
    ├── parse.ts               parse_openapi_spec
    ├── schemas.ts             generate_tool_schemas
    ├── write.ts               write_mcp_server
    ├── config.ts              generate_mcp_config
    ├── validate.ts            run_validation
    └── readme.ts              generate_readme
```

**Protocol-agnostic emitter interface:**

```typescript
function emit(
  ir:       NormalizedOperation[],
  protocol: "mcp",            // extensible: "openai" | "langchain" coming
  ctx:      EmitterContext
): GeneratedServer
```

The IR layer is the compiler's middle-end. `MCP` is the first back-end. Adding OpenAI function calling, LangChain tools, or Vertex AI function declarations means writing a new emitter file — the normalizer and all six tools stay unchanged.

---

## Real-world tested

| Spec | Format | Ops | Features exercised |
|------|--------|-----|-------------------|
| Petstore v2 | Swagger 2.0 | 20 | Swagger adapter, `x-nullable`, apiKey auth, tag filter |
| Petstore v3 | OpenAPI 3.x | 5 | Baseline, `$ref` resolution |
| Stripe subset | OpenAPI 3.x | 12 | `allOf`, discriminator, Bearer auth, nullable fields |
| Jira subset | Swagger 2.0 | 4 | OAuth `flow: application`, `definitions`, `basePath` |
| Circular schema | OpenAPI 3.x | 1 | `z.lazy()` — `Category.parent: Category` |

All integration tests run E2E: `parse → write → tsc --noEmit --strict → MCP probe`.

---

## Development

```bash
npm test          # vitest (105 tests)
npm run typecheck # tsc --noEmit
npm run build     # compile TypeScript → dist/
```

CI runs on every push — Node 18 and Node 20 on ubuntu-latest.

---

## Limitations

| Limitation | Detail |
|-----------|--------|
| No `authorizationCode` OAuth | Requires browser redirect — incompatible with headless stdio MCP |
| No streaming responses | Synchronous HTTP only |
| No `multipart/form-data` | `formData` parameters warn and are dropped; manual implementation required |
| `allOf` with discriminator | Emits `z.unknown()` + warning — complex polymorphism needs manual review |
| Swagger 1.x / RAML / GraphQL | Out of scope |

---

## Roadmap

| Feature | Status |
|---------|--------|
| Tag filter + groupingRecommendation | ✅ V2 |
| `z.lazy()` for circular schemas | ✅ V2 |
| Swagger 2.0 support | ✅ V2 |
| OAuth clientCredentials | ✅ V2 |
| `generate_all_tags` — one command, all groups | Planned V3 |
| OpenAI function calling emitter | Planned V3 |
| Spec diff / change detection | Planned V3 |

---

## License

MIT
