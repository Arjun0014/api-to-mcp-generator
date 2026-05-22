# Changelog

All notable changes to api-to-mcp-generator are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [2.0.0.0] - 2026-05-22

### Added

- **Swagger 2.0 support** — `normalizeSwagger2Doc()` native adapter handles `definitions`, `basePath`/`host`/`schemes`, `x-nullable`, `responses[N].schema`, and `securityDefinitions`. Jira, older Salesforce, and legacy enterprise APIs now parse cleanly. Same IR output as OpenAPI 3.x — everything downstream unchanged.
- **`z.lazy()` for circular schemas** — self-referential schemas (e.g. `Category.parent: Category`) now emit `const CategorySchema: z.ZodTypeAny = z.lazy(() => z.object({...}))` instead of `z.unknown()`. Uses `WeakMap<object, string>` in `NormCtx` to resolve refNames at any recursion depth, with fresh `visited` per definition to prevent false positives.
- **Tag-based filtering on `write_mcp_server`** — new `tag` parameter generates a server from a single tag group. `tag` and `operation_ids` are mutually exclusive. Write-side 100-op guard lifts when either filter is active.
- **`groupingRecommendation` in `parse_openapi_spec`** — specs with >100 operations return a structured recommendation: tag groups, per-group operation counts, and suggested server names. Replaces the hard 100-op throw with actionable guidance.
- **OAuth `clientCredentials` in generated servers** — when a spec uses `flows.clientCredentials` (or Swagger 2.0 `flow: "application"`), the generated `client.ts` includes a token fetcher with caching, automatic refresh, and an axios interceptor. Set `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET`. No manual token management.
- **Cache fix** — `operationsByTag` now computed from `NormalizedOperation.tags` (inline reduce, zero re-parse). `CacheEntry` stores `metadata: { title, version, baseUrl, detectedAuthSchemes }`, eliminating the redundant `SwaggerParser.dereference()` call on every `write_mcp_server` after a parse.
- **`NormalizedOperation.tags: string[]`** — operations now carry their OpenAPI tag list through the IR, enabling tag-based filtering and inline `operationsByTag` computation.
- **`namedSchemas` in emitter context** — `normalizeSpec()` returns `namedSchemas: Record<string, NormalizedSchema>` from `components.schemas`, passed through `EmitterContext` for z.lazy() const hoisting.
- **`oauth_client_credentials` auth type** — extended across `DetectedAuthScheme.type`, `EmitterContext.authType`, `WriteServerInput.auth_type`, `GenerationManifest.options.authType`, and the `write_mcp_server` MCP tool schema.
- **`formData` parameter warnings** — Swagger 2.0 `in: formData` parameters are explicitly unsupported and now emit a per-parameter warning instead of silently dropping them.
- **`tag` in `write_mcp_server` MCP tool schema** — the `tag` parameter and `oauth_client_credentials` auth type are now advertised in the tool's `inputSchema`.
- **SSRF guard on OAuth `tokenUrl`** — `validateSourceUrl()` applied at codegen time before embedding the token endpoint in generated code. If the URL fails validation (private IP), emits an empty string default with an explicit warning.
- **`expires_in` bounds check in generated OAuth client** — defaults to 3600 when `expires_in` is zero, negative, or undefined (per RFC 6749).
- **`refName` identifier validation** — spec-derived schema names are validated against `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/` before being embedded as TypeScript identifiers. Non-identifier names skip z.lazy() and fall back to `z.unknown()`.
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs typecheck + tests + build on Node 18 and 20 for every push and pull request.
- **Vitest 4.x upgrade** — resolves esbuild CVE GHSA-67mh-4wv8-2f99 (dev dependency only; zero production impact).

### Changed

- `normalizeSpec()` now returns `{ operations, namedSchemas, warnings }` (was `{ operations, warnings }`).
- `normalizeDoc()` dispatcher added — callers use `normalizeDoc(doc)` instead of calling `normalizeSpec()` or `normalizeSwagger2Doc()` directly.
- `setCachedIR()` now requires `namedSchemas` and `metadata` arguments; `getCachedEntry()` replaces the old `getCachedIR()` for the full entry.
- `resolveAuthV2()` dead `doc` parameter removed.
- `parse_openapi_spec` 100-op throw replaced by `groupingRecommendation` field.

### Fixed

- **Pass 1 `ctx.visited` stale entries** — normalizer Pass 1 now uses a fresh `visited` WeakSet per definition, preventing false-positive `{ kind: "lazy" }` on body parameters in Pass 2.
- **`buildLazyConsts` missing operation IR** — emitter now also scans operation parameter/requestBody/response schemas for lazy refs, ensuring hoisted const declarations are emitted even when lazy refs only appear in operation bodies.
- **Duplicate `operationsByTag` entries** — operation tags are deduplicated with `[...new Set(tags)]` before building the tag map.
- **Trailing-dash `suggestedServer` names** — tag slugs that normalise to empty string fall back to `"misc"`.
- **Numeric `info.version` in Swagger 2.0** — coerced to string via `String(rawDoc.info.version ?? "")`.
- **OAuth token endpoint errors** — token fetch errors now include the endpoint URL in the message, making auth failures diagnosable in generated servers.

---

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
