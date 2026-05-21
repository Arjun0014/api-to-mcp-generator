# Changelog

All notable changes to api-to-mcp-generator are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [1.0.0.0] - 2026-05-21

### Added

- **6-tool MCP server** — parse, generate schemas, write server, generate config, validate, generate README. Install once in Claude Code; point at any OpenAPI 3.x spec.
- **Protocol-agnostic IR compiler** — `NormalizedOperation[]` discriminated union as the compiler middle-end. MCP is the first back-end; the `emit(ir, "mcp", ctx)` interface makes future protocols (OpenAI function calling, LangChain) a new file, not a rewrite.
- **parse_openapi_spec** — fetches and validates OpenAPI 3.x specs from HTTPS URLs or local files. Returns operations grouped by tag, detected auth schemes, and a spec hash for session caching.
- **generate_tool_schemas** — previews Zod input schemas per operation without generating a full server. Useful for partial integrations or schema inspection before committing to a write.
- **write_mcp_server** — generates and writes a complete TypeScript MCP server. Supports `dry_run` (preview files without writing), `force` (overwrite existing), auth auto-detection from `securitySchemes`, and writes a `.mcp-generator-manifest.json` provenance record.
- **generate_mcp_config** — writes `.mcp.json` for Claude Desktop or Claude Code, auto-populating auth env var from the manifest.
- **run_validation** — compiles the generated server (`tsc --noEmit`), starts it, and probes it with MCP `initialize` + `tools/list`. Phase-based results with per-phase timing.
- **generate_readme** — writes a README for the generated server. Reads from the generation manifest (describes actual generated tools, not the full spec).
- **Session-scoped IR cache** — SHA-256 keyed by raw spec bytes. Five tools calling the same spec hit the cache; zero re-parse overhead on repeated calls.
- **SSRF protection** — IPv4 + IPv6 blocklist; only HTTPS accepted for URL sources. Redirect-following disabled (`maxRedirects: 0`) to prevent redirect-based SSRF bypass.
- **Path traversal protection** — platform-aware (Unix `/etc`, `/usr`, `/bin`; Windows `C:\Windows`, `C:\Program Files`). Output directories validated against home/cwd boundary.
- **Typed `SpecSource` discriminated union** — `{type:"url",url}` vs `{type:"file",path}`. No string inference, no `file://` URLs.
- **Auth injection** — Bearer token, API key header, API key query — auto-detected from OpenAPI `securitySchemes`. Strips auth params from Zod tool schemas; injects via env vars in generated axios client.
- **Atomic writes** — `copyDir` pattern for safe multi-file writes on Windows (avoids `EPERM` on `fs.rename`).
- **Staged resource limits** — 10MB raw spec, 25MB dereferenced, 30s parse timeout, >50 ops warn, >100 ops refuse.
- **Zod input schemas** — all 6 tools validate inputs with Zod; errors surface as `isError: true` MCP responses.
- **77 tests** — security (SSRF, path traversal), normalizer (all schema types, edge cases), parse (petstore, stripe), write (dry_run, collision, manifest, auth detection), E2E (petstore: full pipeline tsc+MCP probe, stripe-subset: allOf+discriminator).

### Fixed

- `parse.ts`: cache branch re-parsed + double-normalized on every call (cache completely bypassed)
- `parse.ts`: temp files from URL-fetched specs leaked on every parse call
- `parse.ts`: axios followed HTTP 302 redirects, bypassing SSRF pre-flight guard
- `parse.ts`: >100 ops guard was unreachable dead code (`as never` + second identical check)
- `security/guards.ts`: `validateOutputDir` home/cwd check was an empty comment with no enforcement
- `mcp.ts`: `auth_env_var` embedded as raw TypeScript identifier without identifier validation
- `mcp.ts`: `buildCase` used `parsed.${key}` — invalid TypeScript for non-identifier parameter names (e.g. `x-request-id`)
- `normalizer.ts`: shared `WeakMap` falsely flagged legitimately reused swagger-parser schema objects as circular references; replaced with `WeakSet` + ancestor-chain add/delete
- `validate.ts`: multiple Promise resolution paths without guard — dangling timeout timer
- `validate.ts`: `shell: true` removed (unnecessary and latent injection surface)
- `schemas.ts`: mutated cached `ParseResult.warnings` — duplicated warnings on repeated calls

### Security

- Added security warning in `write_mcp_server` response when spec is sourced from a URL (prompt injection via malicious spec tool descriptions)
- Added warning when any operation summary exceeds 300 characters
- `auth_env_var` validated against `/^[A-Z_][A-Z0-9_]*$/` before embedding in generated TypeScript
- Emitter file keys validated to stay within `tmpDir` (prevents path-traversal via emitter-generated paths)
- `.gstack/` added to `.gitignore` (security reports stay local)
