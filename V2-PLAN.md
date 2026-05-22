# API-to-MCP Generator — V2 Plan

Status: PLANNED (not started)
Branch: `v2-features` (branch from master once V2 session begins)
V1 branch: `master` (stable, do not modify)

---

## Why V2

V1 works. It generates MCP servers from OpenAPI specs with Zod validation, auth injection,
security hardening, and E2E validation. V2 makes it genuinely usable on real production
APIs — covering the scale, spec format, and auth patterns that enterprise FDE work actually hits.

Four problems V1 has:

1. **Large specs are unusable.** Stripe has 400+ endpoints. V1 refuses if >100, warns
   if >50. The FDE has to manually list operation IDs. There's no grouped generation,
   no automatic tag-based partitioning, no "generate all tags as separate servers" mode.

2. **Circular schemas silently degrade to `z.unknown()`.** Self-referential schemas
   (e.g. `Category { subcategories: Category[] }`) become `z.unknown()` with a warning
   instead of the correct `z.lazy(() => CategorySchema)` that Zod actually supports.

3. **Swagger 2.0 specs are rejected.** ~40% of enterprise APIs (Jira, older Salesforce,
   many internal services) are still on Swagger 2.0. V1 only handles OpenAPI 3.x.

4. **OAuth clientCredentials is not supported.** Salesforce, HubSpot, and many enterprise
   APIs use OAuth clientCredentials (M2M: client_id + client_secret → token endpoint →
   Bearer). V1 detects it and warns, but the generated client can't fetch tokens automatically.

**Note on OAuth scope:** Only `clientCredentials` is in V2. `authorizationCode` (the "user
consents in a browser" flow) is intentionally excluded. An MCP server wrapping an API for
Claude is machine-to-machine — there is no human consenting at runtime. authorizationCode
requires a browser redirect and consent screen, which is incompatible with a headless stdio
MCP process. FDEs building Claude tools don't need it: if they have a user-scoped API token,
they paste it as a static Bearer token (V1 already handles that). clientCredentials is the
gap — it requires dynamic token fetching that the generated client must do automatically.

---

## V2 Features (scope — 6 features)

### Feature 1: Tag-based filtering on `write_mcp_server`

Add a `tag` parameter. When specified, generates a server containing only operations
from that tag group. Removes the 100-op hard limit when `tag` or `operation_ids`
is provided — the user has already made the scoping decision.

```
write_mcp_server({
  source: { type: "url", url: "https://api.stripe.com/openapi.yaml" },
  output_dir: "~/generated/stripe-charges",
  server_name: "stripe-charges",
  tag: "charges"
})
→ generates a 15-tool MCP server for Stripe charges only
```

### Feature 2: Grouping recommendation in `parse_openapi_spec`

When a spec has >100 operations, the parse response includes a
`groupingRecommendation` field that tells Claude exactly what to do next:

```json
{
  "operationCount": 412,
  "groupingRecommendation": {
    "strategy": "generate_by_tag",
    "groups": [
      { "tag": "charges",   "count": 15, "suggestedServer": "stripe-charges" },
      { "tag": "customers", "count": 12, "suggestedServer": "stripe-customers" }
    ],
    "totalGroups": 38,
    "fitsInOneServer": false
  }
}
```

Claude reads this and says: "This spec has 38 groups. Which ones do you need?
I'll generate servers for those." The FDE workflow becomes natural conversation.

### Feature 3: `generate_all_tags` tool (7th MCP tool)

One command that iterates all tag groups and generates a standalone server for each,
up to `max_ops_per_group` per server:

```
generate_all_tags({
  source: { type: "url", url: "https://api.stripe.com/openapi.yaml" },
  base_output_dir: "~/generated/stripe",
  server_name_prefix: "stripe",
  max_ops_per_group: 50
})

Output:
  ~/generated/stripe/
    charges/        → stripe-charges (15 tools, .mcp.json, manifest)
    customers/      → stripe-customers (12 tools, .mcp.json, manifest)
    payment_intents/ → stripe-payment-intents (20 tools, .mcp.json, manifest)
    ...
```

Each subdirectory is a fully independent generated server with its own manifest and config.

### Feature 5: Swagger 2.0 support

V1 only handles OpenAPI 3.x. V2 adds a version-detection step and a Swagger 2.0 → IR adapter.

`@apidevtools/swagger-parser` already handles both formats. The gap is the normalizer:
Swagger 2.0 uses different field names (`definitions` instead of `components/schemas`,
`basePath` instead of `servers[0].url`, `consumes`/`produces` instead of `requestBody`
content types).

```
detect doc.swagger === "2.0" → route to normalizeSwagger2Doc()
detect doc.openapi.startsWith("3.") → existing normalizeopenapiDoc() (unchanged)
```

Both produce the same `NormalizedOperation[]` IR. Everything downstream (emitter, tools,
validation) is unchanged. This is a second normalizer path, not a rewrite.

**What changes in the generated client:** Swagger 2.0 specs use `host` + `basePath` +
`schemes` instead of `servers[0].url`. The base URL resolver handles both formats.

### Feature 6: OAuth clientCredentials auto-token in generated servers

When a spec uses OAuth `clientCredentials` flow, the generated `client.ts` automatically
fetches and refreshes tokens instead of requiring a pre-obtained Bearer token.

```typescript
// Generated client.ts for OAuth clientCredentials:
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const res = await axios.post(TOKEN_ENDPOINT, {
    grant_type: "client_credentials",
    client_id: process.env.OAUTH_CLIENT_ID,
    client_secret: process.env.OAUTH_CLIENT_SECRET,
    scope: REQUIRED_SCOPES
  });
  tokenCache = { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return tokenCache.token;
}

// Axios interceptor: inject token before every request
client.interceptors.request.use(async (config) => {
  config.headers.Authorization = `Bearer ${await getToken()}`;
  return config;
});
```

**Env vars generated:** `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_ENDPOINT`
(populated from the spec's `tokenUrl` field).

**authorizationCode is explicitly excluded.** That flow requires a browser redirect and
user consent — incompatible with a headless MCP stdio server. FDEs using user-scoped
tokens paste them as static Bearer tokens (already supported in V1).

### Feature 4: `z.lazy()` support for circular schemas

Replace `{ kind: "unknown", warning: "circular..." }` with proper `z.lazy()` generation
when a schema is genuinely self-referential (not just shared — true ancestor-cycle).

```typescript
// Instead of: z.unknown()
// Generates:
const CategorySchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    id: z.string(),
    subcategories: z.array(CategorySchema)
  })
);
```

New IR kind: `{ kind: "lazy"; refName: string }` derived from the OpenAPI `$ref` path
(e.g. `#/components/schemas/Category` → `CategorySchema`).

---

## What is explicitly NOT in V2

- Mock mode (deferred — separate feature)
- OpenAI function calling emitter (deferred — interface designed in V1, emitter in V3)
- Spec diff / change detection (deferred — needs manifest foundation from V1 first)
- OAuth authorizationCode (intentionally excluded — requires browser + user consent, incompatible with headless MCP stdio)
- OAuth implicit / password (deprecated flows, no demand)

---

## Affected Files

```
src/
├── ir/types.ts                ← add NormalizedSchema "lazy" kind
├── codegen/normalizer.ts      ← emit lazy kind for circular; add Swagger 2.0 adapter
├── codegen/emitters/mcp.ts    ← handle lazy kind → z.lazy(); OAuth clientCredentials token fetcher
├── tools/parse.ts             ← add groupingRecommendation; Swagger 2.0 version detection
├── tools/write.ts             ← add tag parameter, lift limit when filtered
├── tools/batch.ts             ← NEW: generate_all_tags tool
├── types.ts                   ← add GroupingRecommendation, OAuthFlow types; update ParseResult
└── index.ts                   ← register generate_all_tags as 7th tool

tests/
├── normalizer.test.ts         ← add z.lazy() test cases; Swagger 2.0 normalizer tests
├── parse.test.ts              ← add groupingRecommendation tests; Swagger 2.0 parse tests
├── write.test.ts              ← add tag filter tests
├── batch.test.ts              ← NEW: generate_all_tags tests
└── integration/
    ├── stripe-full.test.ts    ← NEW: E2E against Stripe spec (tag-filtered, OAuth clientCreds)
    └── swagger2.test.ts       ← NEW: E2E against a real Swagger 2.0 spec

tests/fixtures/
└── jira-swagger2-subset.yaml  ← NEW: Swagger 2.0 fixture with auth
```

Total new/modified files: ~12. All changes are additive — new parameters, new normalizer
path, new tool. No existing behavior modified.

---

## V2 Implementation Constraints (inherit from V1)

These constraints from V1 apply unchanged in V2:

- Strict TypeScript, no `any`, no silent fallbacks
- All tool errors via `isError: true` — never throw to transport
- SpecSource discriminated union `{type:"url"}|{type:"file"}` for all source params
- SSRF guard (IPv4+IPv6) + path traversal guard (Unix+Windows) on all inputs
- `force: true` bypasses collision check only, never security guards
- Session-scoped SHA-256-keyed IR cache — V2 tools use same cache as V1
- Atomic `copyDir` write pattern for all file writes
- Generated servers use `void (async()=>{})()` wrapper (CommonJS compat)
- Auth env var validated as `/^[A-Z_][A-Z0-9_]*$/` before embedding in generated code

---

## Definition of Done

V2 is complete when:

1. `parse_openapi_spec` on a 400+ op spec returns `groupingRecommendation` with
   tag groups, counts, and suggested server names
2. `write_mcp_server` with `tag: "charges"` generates a Stripe charges server that
   passes `tsc --noEmit --strict` and MCP probe
3. `generate_all_tags` on a large spec creates multiple independent server directories,
   each with manifest, .mcp.json, and passing validation
4. A self-referential schema (e.g. `Category { subcategories: Category[] }`) generates
   `z.lazy()` in the output instead of `z.unknown()`
5. A Swagger 2.0 spec (e.g. Jira subset) parses and generates a working MCP server
6. A spec with OAuth `clientCredentials` generates a `client.ts` that fetches tokens
   automatically using `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` env vars
7. All existing V1 tests still pass (77/77)
8. New V2 tests cover all six features
9. `demo-test.md` updated with V2 workflow examples

---

## V2 Branch Strategy

```
master (V1, stable)
  └── v2-features (branch here)
        ├── feat/tag-filter
        ├── feat/grouping-recommendation  
        ├── feat/generate-all-tags
        └── feat/lazy-schemas
```

All V2 work happens on `v2-features`. V1 (`master`) is never touched.
Once all V2 features pass tests and review, merge `v2-features` → `master`.

---

## gstack Workflow for V2 Session

Follow the full gstack sprint in this order:

1. `/office-hours` — validate demand for each feature, confirm FDE use cases
2. `/plan-ceo-review` — scope decisions, approach selection, SELECTIVE EXPANSION mode
3. `/plan-eng-review` — architecture lock-in, data flow, test coverage, edge cases
4. `/careful` — activate before any file writes
5. Implementation in phases (see below)
6. `/review` — diff-scoped pre-landing review after implementation
7. `/cso` — security audit (new tool, new input parameters)
8. `/document-generate` — update README and demo-test.md
9. `/ship` — create PR from `v2-features` → `master`

---

## V2 Implementation Phases

### Phase 1 — IR + Types (~15 min CC)
- Add `lazy` kind to `NormalizedSchema` in `src/ir/types.ts`
- Add `GroupingRecommendation` type to `src/types.ts`
- Update `ParseResult` to include optional `groupingRecommendation`

### Phase 2 — Normalizer + Emitter (~30 min CC)
- `src/codegen/normalizer.ts`: emit `{ kind: "lazy", refName }` for true ancestor-cycle circular refs
  - `refName` derived from swagger-parser's tracked `$ref` path
  - Distinguish true cycle (ancestor chain) from shared schema (same object, different location)
- `src/codegen/emitters/mcp.ts`: handle `lazy` kind → `const SchemaName: z.ZodTypeAny = z.lazy(() => ...)`
- `tests/normalizer.test.ts`: add self-referential schema test cases

### Phase 3 — Parse Tool (~15 min CC)
- `src/tools/parse.ts`: compute `groupingRecommendation` when `operationCount > 100`
  - Group by tag, compute per-tag counts, generate suggested server names
  - Include `fitsInOneServer: false` signal
- `tests/parse.test.ts`: add grouping recommendation tests

### Phase 4 — Write Tool + Batch Tool (~25 min CC)
- `src/tools/write.ts`: add `tag?: string` parameter; when set, filter IR by tag; lift 100-op limit
- `src/tools/batch.ts` (NEW): `generate_all_tags` — iterates `operationsByTag`, calls write logic per group
- `src/index.ts`: register `generate_all_tags` as 7th tool
- `tests/write.test.ts`: add tag filter tests
- `tests/batch.test.ts` (NEW): generate_all_tags tests

### Phase 5 — Integration + Demo (~20 min CC)
- `tests/integration/stripe-full.test.ts` (NEW): E2E test against Stripe spec, tag-filtered
- Update `demo-test.md` with V2 workflow section

---

## V2 Implementation Phases (updated)

### Phase 1 — IR + Types (~15 min CC)
- Add `lazy` kind to `NormalizedSchema` in `src/ir/types.ts`
- Add `GroupingRecommendation` and `OAuthClientCredentialsFlow` types to `src/types.ts`
- Update `ParseResult` to include optional `groupingRecommendation`
- Update `NormalizedAuth` to include `tokenEndpoint?: string` for clientCredentials

### Phase 2 — Normalizer: Swagger 2.0 + z.lazy() (~45 min CC)
- `src/codegen/normalizer.ts`:
  - Version detection: `doc.swagger === "2.0"` → route to `normalizeSwagger2Doc()`
  - Swagger 2.0 adapter: map `definitions`, `basePath`, `consumes`/`produces` → IR
  - Emit `{ kind: "lazy", refName }` for true ancestor-cycle circular refs
- `src/codegen/emitters/mcp.ts`: handle `lazy` kind → `z.lazy()` generation
- Tests: Swagger 2.0 normalizer + z.lazy() test cases

### Phase 3 — Parse Tool (~15 min CC)
- `src/tools/parse.ts`:
  - Compute `groupingRecommendation` when `operationCount > 100`
  - Handle Swagger 2.0 base URL resolution (`host` + `basePath` + `schemes`)
- Tests: grouping recommendation + Swagger 2.0 parse

### Phase 4 — Write Tool + Batch Tool + OAuth clientCredentials (~40 min CC)
- `src/tools/write.ts`: add `tag?: string` parameter; lift 100-op limit when filtered
- `src/tools/batch.ts` (NEW): `generate_all_tags` tool
- `src/codegen/emitters/mcp.ts`: generate OAuth clientCredentials token fetcher in `client.ts`
  when `auth.type === "oauth_client_credentials"`
- `src/index.ts`: register `generate_all_tags` as 7th tool
- Tests: tag filter + batch + OAuth clientCredentials generated code

### Phase 5 — Integration + Demo (~25 min CC)
- `tests/integration/stripe-full.test.ts`: Stripe spec, tag-filtered
- `tests/integration/swagger2.test.ts`: Swagger 2.0 E2E
- `tests/fixtures/jira-swagger2-subset.yaml`: Swagger 2.0 fixture
- Update `demo-test.md` with V2 workflow

## Estimated Total CC Time

| Phase | Time |
|-------|------|
| Phase 1: IR + Types | ~15 min |
| Phase 2: Normalizer (Swagger 2.0 + z.lazy()) | ~45 min |
| Phase 3: Parse Tool | ~15 min |
| Phase 4: Write + Batch + OAuth | ~40 min |
| Phase 5: Integration + Demo | ~25 min |
| Review + CSO + Ship | ~30 min |
| **Total** | **~2h 50min** |

---

## V1 Compatibility Guarantee

V2 adds new parameters and a new tool. It does not change:
- Any existing tool's input schema (only adds optional parameters)
- Any existing tool's output shape (only adds optional fields)
- The IR types for existing schema kinds
- Any security guard behavior
- The normalizer's handling of non-circular schemas

An FDE using V1 workflows will see identical behavior. V2 features only activate
when the new parameters are explicitly provided.
