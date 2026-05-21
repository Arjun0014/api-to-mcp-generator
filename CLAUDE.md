# API-to-MCP Generator

## Project Overview
A CLI-only MCP server that reads an OpenAPI spec (URL or file) and generates a fully working TypeScript MCP server with Zod schemas, error handling, and config. A meta-MCP: an MCP that creates other MCPs.

Built as a portfolio project for the realfast.ai Forward Deployed Engineer role.

## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /land-and-deploy, /qa, /qa-only, /design-review,
/retro, /investigate, /document-release, /document-generate, /cso, /autoplan, /careful,
/freeze, /guard, /unfreeze, /gstack-upgrade, /learn.

## Architecture
- **Runtime**: Node.js 18+ / TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Schema validation**: Zod
- **OpenAPI parsing**: `@apidevtools/swagger-parser` + custom traversal
- **CLI entry**: `src/index.ts` (stdio transport)
- **Output**: generated TypeScript files written to disk

## Tools Exposed (the 6 MCP tools this server provides)
1. `parse_openapi_spec` — fetch + validate an OpenAPI 3.x spec from URL or file path
2. `generate_tool_schemas` — convert OpenAPI operations to Zod schema definitions
3. `write_mcp_server` — write the full generated TypeScript MCP server to disk
4. `generate_mcp_config` — produce `.mcp.json` for Claude Desktop / Claude Code
5. `run_validation` — spawn the generated server, probe it, report health
6. `generate_readme` — write a README for the generated server

## Key Invariants
- All tools must return structured JSON (not plain text)
- Tool errors must use MCP `isError: true` pattern, never throw to transport
- Generated code must pass `tsc --noEmit` with strict mode
- Zod schemas must be generated, never hardcoded
- Auth headers (Bearer, API key) must be injectable via env vars in generated servers

## File Structure
```
api-to-mcp-generator/
├── src/
│   ├── index.ts                    # MCP server entry, registers all 6 tools
│   ├── cache.ts                    # Session-scoped hash-keyed IR cache
│   ├── types.ts                    # Shared non-IR types: ParseResult, GeneratedServer, WarningCollection
│   ├── ir/
│   │   └── types.ts                # NormalizedOperation, NormalizedSchema, NormalizedAuth, etc.
│   ├── security/
│   │   └── guards.ts               # validateSourceUrl() (SSRF IPv4+IPv6), validateOutputDir() (Unix+Windows)
│   ├── tools/
│   │   ├── parse.ts                # parse_openapi_spec
│   │   ├── schemas.ts              # generate_tool_schemas
│   │   ├── write.ts                # write_mcp_server
│   │   ├── config.ts               # generate_mcp_config
│   │   ├── validate.ts             # run_validation
│   │   └── readme.ts               # generate_readme
│   └── codegen/
│       ├── normalizer.ts           # OpenAPI → IR (dispatcher + per-type helpers)
│       ├── emitters/
│       │   ├── index.ts            # emit(ir, protocol, ctx) interface + registry
│       │   └── mcp.ts              # MCPEmitter — all MCP server TypeScript assembly
│       └── templates.ts            # String fragments used by mcp.ts
├── tests/
│   ├── security.test.ts
│   ├── normalizer.test.ts
│   ├── parse.test.ts
│   ├── write.test.ts
│   ├── integration/
│   │   ├── petstore.test.ts        # E2E: parse → write → tsc → MCP probe
│   │   └── stripe-subset.test.ts  # E2E: allOf + discriminator handling
│   └── fixtures/                  # petstore.yaml, stripe-subset.yaml
├── CLAUDE.md
├── TODOS.md
├── SESSION.md                      # ← session state, re-entry prompt, artifact registry
├── README.md
├── package.json
├── tsconfig.json
└── .mcp.json                       # Config to use THIS server in Claude
```

**Note:** `zod-gen.ts` and `server-gen.ts` from the original SPEC.md do not exist.
The normalizer (`src/codegen/normalizer.ts`) and the MCP emitter (`src/codegen/emitters/mcp.ts`) replace them.

## Commands
- `npm run build` — compile TypeScript
- `npm run dev` — ts-node for development
- `npm test` — vitest
- `npm run typecheck` — tsc --noEmit
- `node dist/index.js` — run the MCP server

## Design Decisions
- Use `stdio` transport (not HTTP) — Claude Code and Claude Desktop both use stdio
- Generated servers also use `stdio` transport
- Scope to OpenAPI 3.x only (not Swagger 2.0) for clean implementation
- Handle `$ref` resolution via swagger-parser before codegen
- Auth: generate env-var-based injection (BEARER_TOKEN, API_KEY_HEADER) in output
- Error handling: wrap all HTTP calls in try/catch, surface as MCP tool errors
- `source` input uses discriminated union `{type:"url",url}|{type:"file",path}` — no string inference, no file:// URLs
- IR cache keyed by SHA-256 of raw spec bytes — safe stale-spec protection, avoids re-parse on same spec
- `write_mcp_server` uses `copyDir` instead of `fs.rename` — Windows EPERM workaround for temp→target moves
- Generated servers use `void (async()=>{})()` wrapper — top-level await not valid in CommonJS output
- `normalizeSchema()` is a dispatcher calling per-type private helpers — keeps cyclomatic complexity low and each case independently testable
- `NormCtx.depth` guard at 20 — prevents stack overflow on adversarial deeply-nested schemas

## Out of Scope (v1)
- Swagger 2.0 / RAML / GraphQL
- OAuth flows (too complex for v1, document as limitation)
- Streaming responses
- File upload endpoints

## Session State

Planning is COMPLETE. Implementation is COMPLETE (Phases 1–4).
77/77 tests passing. E2E petstore + stripe-subset validated.

**Next action:** Phase 5 hardening — `/review` → `/cso` → `/ship`

**Master plan:**
`/c/Users/aswin/.gstack/projects/api-to-mcp-generator/ceo-plans/2026-05-21-api-to-mcp-generator.md`

**Session artifact registry:**
`/c/Users/aswin/.gstack/projects/api-to-mcp-generator/SESSION.md`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
