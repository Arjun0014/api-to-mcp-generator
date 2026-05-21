# TODOS.md — api-to-mcp-generator

## P2: CI/CD — GitHub Actions build+test workflow

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

## P3: Second protocol emitter (OpenAI function calling)

**What:** `src/codegen/emitters/openai.ts` — emits OpenAI function calling JSON format from `NormalizedOperation[]`.

**Why:** The emitter interface `emit(ir, "openai", ctx)` is designed in v1 but the emitter is not built. FDEs at consultancies often work with both Claude and GPT-4 clients.

**Context:** The v1 `emit(ir, "mcp", ctx)` establishes the interface. Adding "openai" is a new ~50-line file implementing the same interface for OpenAI's `{ name, description, parameters: { type: "object", properties: {...} } }` shape.

**Effort:** S (human: ~2 days / CC: ~30min)
**Depends on:** v1 complete + emitter interface stable
