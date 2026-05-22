# TODOS.md — api-to-mcp-generator

## P2: generate_all_tags — 7th MCP tool

**What:** `generate_all_tags({ source, base_output_dir, server_name_prefix, max_ops_per_group })` — iterates all tag groups from `groupingRecommendation` and calls the `write_mcp_server` logic once per group. Each subdirectory is an independent generated server with its own manifest and `.mcp.json`.

**Why:** For FDEs wrapping an entire API (e.g. all of Stripe for an internal toolbox), calling `write_mcp_server` 38 times manually is tedious. One command to generate all groups.

**Context:** Deferred from V2 (V2 ships tag filter + groupingRecommendation which is sufficient for selective use). `generate_all_tags` is trivially a loop over `groupingRecommendation.groups` calling the existing write logic. Architecturally free once V2 is merged.

**Effort:** M (human: ~1 day / CC: ~40min)
**Depends on:** V2 merged (tag filter, groupingRecommendation)

---

## P3: OAuth `getToken()` concurrency guard

**What:** Add a mutex/in-flight deduplication to the generated `getToken()` function in `client.ts`. When multiple concurrent API calls fire simultaneously during token refresh, only one token request should be made; others should await the same promise.

**Why:** Current generated code has a race: 10 parallel tool calls each check `tokenCache === null` before it's populated, all fire separate token requests. For rate-limited token endpoints this causes 429s.

**Context:** Identified by adversarial review (V2). The fix is a `let tokenFetchInFlight: Promise<string> | null = null` pattern. Low priority — only affects high-concurrency MCP usage which is rare in practice.

**Effort:** S (human: ~1h / CC: ~10min)
**Depends on:** V2 merged

---

## P3: normalizeSchemaV2Inner / normalizeSchemaInner DRY refactor

**What:** Extract a shared inner dispatcher `normalizeSchemaInnerCommon(schema, nullable, ctx, recurse)` from the duplicated scalar/array/object/enum branches in both V3 and V2 schema normalizers.

**Why:** ~55 lines of logic are duplicated between the two normalizer paths. Drift risk as new schema types are added.

**Context:** Identified by maintainability specialist review. Low priority since both functions are tested independently and the duplication is bounded.

**Effort:** S (human: ~1h / CC: ~15min)
**Depends on:** V2 merged

---

## ✅ DONE: CI/CD — GitHub Actions build+test workflow (shipped in V2)

**What:** `.github/workflows/ci.yml` that runs on every push/PR.

**Why:** Portfolio project on GitHub needs CI to be credible as compiler/tooling infrastructure. Prevents silent regressions on the normalization pipeline.

**Stages:**
```yaml
- npm install
- npm run typecheck   # tsc --noEmit
- npm test            # vitest run
- npm run build       # tsc
```

**Context:** CI is not architecture-blocking. The IR contracts, emitter boundaries, security model, and validation semantics must stabilize first (Phases 1-4). Add CI in Phase 5 before `/ship`. Target platforms: Node 18, Node 20. OS: ubuntu-latest.

**Effort:** S (human: ~30min / CC: ~10min)
**Depends on:** GitHub repository initialized (`https://github.com/Arjun0014/api-to-mcp-generator`)
**Repository description:** "Protocol-aware OpenAPI normalization compiler that generates deterministic MCP servers from real-world API specs."
**License:** MIT

---

## P2: Spec diff / change detection

**What:** `parse_openapi_spec` accepts an optional `baseline_manifest` parameter (path to `.mcp-generator-manifest.json` from a prior generation run). Returns `{ added: OperationSummary[], removed: OperationSummary[], changed: OperationSummary[], unchanged: number }`.

**Why:** FDE repeat-engagement workflow: client API updated after 3 months. Without diff, FDE must fully regenerate and manually reconcile changes. With diff, FDE regenerates only changed operations.

**Implementation start:**
1. Read `baseline_manifest` from disk → get `specHash` and `generatedTools`
2. Parse current spec → get current hash
3. If hashes match → no diff (return unchanged count)
4. If hashes differ → operation-level diff by `toolName`
5. Return diff result alongside the normal ParseResult

**Enabling primitive:** `.mcp-generator-manifest.json` (in v1 scope) — contains `specHash`, `generatedTools[]`, `generatedAt`. This makes efficient diffing possible without re-normalizing both specs fully.

**Effort:** M (human: ~2 days / CC: ~30min)
**Depends on:** Generation manifest (v1, in scope)
**Blocked by:** Nothing — can be implemented after v1 ships

---

## ✅ DONE: Upgrade vitest to 4.x (esbuild CVE GHSA-67mh-4wv8-2f99) (shipped in V2)

**What:** `npm audit fix --force` to upgrade vitest 1.x → 4.x, fixing the esbuild dev server CORS bypass.

**Why:** `esbuild ≤0.24.2` has a known CVE (dev server CORS bypass). Zero production risk (dev dep only, no UI), but keeps the audit clean.

**Context:** Only exploitable if developer runs `vitest --ui` while browsing a malicious site. Standard CI runs (`npm test`) are not affected.

**Effort:** S (human: ~30min to check for breaking API changes / CC: ~10min)
**Depends on:** None — standalone upgrade

---

## P3: Second protocol emitter (OpenAI function calling)

**What:** `src/codegen/emitters/openai.ts` — emits OpenAI function calling JSON format from `NormalizedOperation[]`.

**Why:** The emitter interface `emit(ir, "openai", ctx)` is designed in v1 but the emitter is not built. FDEs at consultancies often work with both Claude and GPT-4 clients.

**Context:** The v1 `emit(ir, "mcp", ctx)` establishes the interface. Adding "openai" is a new ~50-line file implementing the same interface for OpenAI's `{ name, description, parameters: { type: "object", properties: {...} } }` shape.

**Effort:** S (human: ~2 days / CC: ~30min)
**Depends on:** v1 complete + emitter interface stable
