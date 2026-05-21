# Session State

## V1 Status: COMPLETE AND SHIPPED

V1 is stable on `master`. 77/77 tests passing. Reviewed, security audited, shipped to GitHub.

- `/review` — 12 issues found and fixed (cache bypass, SSRF redirect, empty output guard, etc.)
- `/cso` — 2 security findings (1 fixed, 1 accepted risk)
- Deployed to: https://github.com/Arjun0014/api-to-mcp-generator

---

## V2 Status: IMPLEMENTATION COMPLETE

V2 is implemented on `v2-features`. 104/104 tests passing. Ready for `/review` → `/cso` → `/ship`.

**Next action:** `/review` diff-scoped review, then `/cso`, then `/ship` v2-features → master.

### V2 Features (6 total)
1. Tag-based filtering on `write_mcp_server` (lift 100-op limit when filtered)
2. `groupingRecommendation` in `parse_openapi_spec` output (for 100+ op specs)
3. `generate_all_tags` — 7th MCP tool (one server per tag group)
4. `z.lazy()` support for circular schemas (replace `z.unknown()` fallback)
5. **Swagger 2.0 support** — covers ~40% of enterprise APIs (Jira, older Salesforce)
6. **OAuth clientCredentials** — M2M token fetching in generated client.ts

### What is NOT in V2 (intentional)
- OAuth authorizationCode — requires browser/user consent, incompatible with headless MCP stdio
- Mock mode — separate feature
- OpenAI function calling emitter — interface in V1, emitter in V3

---

## V2 Kickstart Prompt

Copy this exactly to start the V2 session:

```
Starting V2 of api-to-mcp-generator. V1 is complete and stable on master
(77 tests passing, shipped to https://github.com/Arjun0014/api-to-mcp-generator).
V2 must NOT touch master until all features are working.

Step 1 — before anything else:
  git checkout -b v2-features

Step 2 — read these files:
  - V2-PLAN.md (in project root) — full V2 scope, phases, constraints
  - /c/Users/aswin/.gstack/projects/api-to-mcp-generator/ceo-plans/2026-05-21-api-to-mcp-generator.md
    (V1 CEO plan — architecture decisions that V2 must inherit)

Step 3 — run the full gstack workflow in order:
  /office-hours  → validate all 6 V2 features with real FDE use cases
  /plan-ceo-review → scope review, SELECTIVE EXPANSION mode
  /plan-eng-review → architecture for the new features
  /careful → activate before any file writes
  → implement Phases 1-5 from V2-PLAN.md
  /review → diff-scoped review after implementation
  /cso → security audit (new tool, new auth paths, Swagger 2.0 input)
  /ship → PR from v2-features → master

V2 features (all 6 required):
1. tag parameter on write_mcp_server — filter by tag, lift 100-op limit when filtered
2. groupingRecommendation in parse_openapi_spec — for 100+ op specs, tells Claude how to split
3. generate_all_tags — 7th MCP tool, one server per tag group, auto-iterates all tags
4. z.lazy() in normalizer — true circular schemas → z.lazy() instead of z.unknown()
5. Swagger 2.0 support — version detection + Swagger 2.0 → IR adapter (definitions, basePath)
6. OAuth clientCredentials — generated client.ts fetches/refreshes tokens automatically
   using OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET env vars + tokenUrl from spec

authorizationCode OAuth is intentionally excluded. It requires a browser redirect and
user consent — incompatible with headless MCP stdio. FDEs paste user-scoped tokens as
static Bearer tokens (V1 already handles that).

V1 compatibility guarantee (must be maintained):
- All 77 existing V1 tests must still pass after V2 implementation
- V2 only adds optional parameters and a new tool — no existing behavior changes
- An FDE using V1 workflows sees identical output

Key constraints inherited from V1:
- Strict TypeScript, no any, no silent fallbacks
- SpecSource discriminated union {type:"url"}|{type:"file"} on all source params
- SSRF guard (IPv4+IPv6) + path traversal guard (Unix+Windows) on all inputs
- Session-scoped SHA-256-keyed IR cache (V2 tools reuse same cache)
- All tool errors via isError: true — never throw to transport
- Atomic copyDir write for all file writes
- Generated servers: void (async()=>{})() wrapper (CommonJS compat)
- Auth env var validated as /^[A-Z_][A-Z0-9_]*$/ before embedding in generated code

Project root: C:\MCP build\api-to-mcp-generator
GitHub: https://github.com/Arjun0014/api-to-mcp-generator
V2 plan: V2-PLAN.md
Estimated V2 CC time: ~2h 50min across 5 phases
```

---

## Key File Paths

| File | Purpose |
|------|---------|
| `V2-PLAN.md` | V2 scope, phases, constraints, definition of done |
| `CLAUDE.md` | Architecture, file structure, design decisions |
| `TODOS.md` | Deferred items (spec diff, OpenAI emitter, vitest upgrade) |
| `/c/Users/aswin/.gstack/projects/api-to-mcp-generator/ceo-plans/2026-05-21-api-to-mcp-generator.md` | V1 master plan — all V1 architectural decisions |
| `demo-test.md` | Live demo walkthrough — needs V2 section added |

---

## V1 Bugs Fixed (reference)

1. `writeAtomic`: `fs.rename()` EPERM on Windows → replaced with `copyDir`
2. MCPEmitter: runtime helpers not emitted into generated server → moved to `RUNTIME_HELPERS`
3. Generated server: top-level `await` in CommonJS → `void (async()=>{})()` wrapper
4. SSRF guard: IPv6-mapped addresses normalize to hex form in Node → added hex prefixes
5. `normalizeAllOfSchema`: missing `ctx` parameter
6. `normalizeArraySchema`: requires cast to `ArraySchemaObject` for `.items` access
7. Cache branch: re-parsed + double-normalized on every call (cache completely bypassed)
8. Temp files: URL-fetched specs leaked in `/tmp` → `try/finally` cleanup
9. `validateOutputDir`: home/cwd check was empty no-op comment → now enforced
10. axios SSRF: followed 302 redirects bypassing pre-flight → `maxRedirects: 0`
11. `buildCase`: `parsed."x-id"` invalid for non-identifier params → bracket notation
12. `NormCtx.visited`: WeakMap falsely flagged reused schemas → WeakSet with add/delete
