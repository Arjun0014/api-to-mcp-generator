# api-to-mcp-generator — Live Demo

This document walks through the full 6-tool pipeline against the Petstore spec.
Each section shows the exact input, what the tool does, and the real output.

---

## The spec we're using

`tests/fixtures/petstore.yaml` — a standard OpenAPI 3.0 spec with 5 endpoints across 2 tags, no auth.

```
GET  /pets          → list all pets (with optional limit + tags filter)
POST /pets          → create a pet (requires name, optional tag)
GET  /pets/{petId}  → get one pet by ID
DEL  /pets/{petId}  → delete a pet
GET  /owners        → list all owners
```

---

## Tool 1: `parse_openapi_spec`

**What it does:** Reads the spec, dereferences all `$ref` links, normalizes every operation into a structured summary. Returns operations grouped by tag so you can filter large specs before generating.

**Input:**
```json
{
  "source": { "type": "file", "path": "./tests/fixtures/petstore.yaml" }
}
```

**Output (abbreviated):**
```json
{
  "title": "Petstore",
  "version": "1.0.0",
  "baseUrl": "https://petstore.example.com/v1",
  "operationCount": 5,
  "operations": [
    { "operationId": "listPets",    "toolName": "list_pets",       "method": "get",    "path": "/pets",          "hasRequestBody": false },
    { "operationId": "createPets",  "toolName": "create_pets",     "method": "post",   "path": "/pets",          "hasRequestBody": true  },
    { "operationId": "showPetById", "toolName": "show_pet_by_id",  "method": "get",    "path": "/pets/{petId}",  "hasRequestBody": false },
    { "operationId": "deletePet",   "toolName": "delete_pet",      "method": "delete", "path": "/pets/{petId}",  "hasRequestBody": false },
    { "operationId": "listOwners",  "toolName": "list_owners",     "method": "get",    "path": "/owners",        "hasRequestBody": false }
  ],
  "operationsByTag": {
    "pets":   [ "list_pets", "create_pets", "show_pet_by_id", "delete_pet" ],
    "owners": [ "list_owners" ]
  },
  "detectedAuthSchemes": [],
  "specHash": "283a89067e66a185439e1dc2162f1d803e9a5f718e7178302a7eb262c9b9ff99",
  "warnings": []
}
```

**What to notice:**
- `toolName` is already snake_case — ready to use as an MCP tool name.
- `operationsByTag` lets you say "generate only the pets group" on large APIs (Stripe has 50+ tags).
- `specHash` is a SHA-256 of the raw spec bytes. Every subsequent tool call for the same spec hits the cache — no re-parsing.
- `detectedAuthSchemes` is empty here (no auth). For a spec with Bearer auth, this would show `[{ "type": "bearer", "envVar": "BEARER_TOKEN" }]` and the generated server would auto-inject it.

---

## Tool 2: `generate_tool_schemas`

**What it does:** Converts OpenAPI schemas to Zod validation strings. Use this to preview exactly what input validation will look like before generating the full server. Useful for partial integrations — you can take these schemas and use them in an existing MCP server.

**Input:**
```json
{
  "source": { "type": "file", "path": "./tests/fixtures/petstore.yaml" },
  "operation_ids": ["listPets", "createPets", "showPetById"]
}
```

**Output:**
```json
{
  "schemas": [
    {
      "operation_id": "listPets",
      "tool_name": "list_pets",
      "input_schema_zod": "z.object({\n  limit: z.number().int().optional(),\n  tags: z.array(z.string()).optional()\n})",
      "description": "List all pets",
      "warnings": []
    },
    {
      "operation_id": "createPets",
      "tool_name": "create_pets",
      "input_schema_zod": "z.object({\n  body: z.object({\n  name: z.string(),\n  tag: z.string().optional()\n})\n})",
      "description": "Create a pet",
      "warnings": []
    },
    {
      "operation_id": "showPetById",
      "tool_name": "show_pet_by_id",
      "input_schema_zod": "z.object({\n  petId: z.string()\n})",
      "description": "Info for a specific pet",
      "warnings": []
    }
  ]
}
```

**What to notice:**
- `limit` is `z.number().int()` — the IR detected `type: integer` and mapped it correctly. Not just `z.number()`.
- `tag` on `createPets` body is `.optional()` — the normalizer read the OpenAPI `required: ["name"]` array on the parent object and flagged `tag` as not required.
- `petId` is `z.string()` — path parameters are always required (auto-set by the normalizer since path params must be present).
- `warnings: []` — clean. Complex specs (allOf with discriminators, circular refs) produce warnings here instead of silent failures.

---

## Tool 3: `write_mcp_server`

**What it does:** Generates a complete TypeScript MCP server and writes it to disk. Run with `dry_run: true` first to see what would be written, then without it to commit.

### Step 3a — Preview with `dry_run: true`

**Input:**
```json
{
  "source": { "type": "file", "path": "./tests/fixtures/petstore.yaml" },
  "output_dir": "~/generated-mcp/petstore-demo",
  "server_name": "petstore-api",
  "dry_run": true
}
```

**Output — files that would be written:**
```
src/index.ts                   ← the MCP server (tools registered, Zod validation, HTTP calls)
src/client.ts                  ← axios client pre-configured with base URL
package.json                   ← ready to npm install
tsconfig.json                  ← strict TypeScript config
.env.example                   ← auth token placeholder (empty here, no auth)
.mcp-generator-manifest.json   ← provenance record
```

**Generated `src/index.ts` (excerpt):**
```typescript
// Generated by api-to-mcp-generator — do not edit manually
// Server: petstore-api

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { client } from "./client.js";

const server = new Server(
  { name: "petstore-api", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Zod schemas — one per operation, derived from the spec
const list_petsSchema = z.object({
  limit: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
});

const create_petsSchema = z.object({
  body: z.object({
    name: z.string(),
    tag: z.string().optional(),
  }).describe("Request body"),
});

const show_pet_by_idSchema = z.object({
  petId: z.string().describe("The id of the pet to retrieve"),
});
```

**Generated `src/client.ts`:**
```typescript
import axios from "axios";

const client = axios.create({
  baseURL: "https://petstore.example.com/v1",
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    // For Bearer auth specs, this would inject:
    // ...(process.env.BEARER_TOKEN ? { "Authorization": `Bearer ${process.env.BEARER_TOKEN}` } : {})
  },
});

export { client };
```

**`.mcp-generator-manifest.json`** — the provenance record:
```json
{
  "generatorVersion": "1.0.0",
  "irVersion": "1",
  "generatedAt": "2026-05-21T11:21:16.721Z",
  "specSource": { "type": "file", "path": "..." },
  "specHash": "283a89067e66a185439e1dc2162f1d803e9a5f718e7178302a7eb262c9b9ff99",
  "selectedOperations": ["listPets", "createPets", "showPetById", "deletePet", "listOwners"],
  "generatedTools": ["list_pets", "create_pets", "show_pet_by_id", "delete_pet", "list_owners"],
  "options": { "serverName": "petstore-api", "baseUrl": "https://petstore.example.com/v1", "authType": "none" }
}
```

The manifest is how `generate_readme` and `generate_mcp_config` know what was generated — they read it instead of re-parsing the spec.

### Step 3b — Write for real (same input, `dry_run: false`)

```json
{
  "files_written": ["src/index.ts", "src/client.ts", "package.json", "tsconfig.json", ".env.example", ".mcp-generator-manifest.json"],
  "output_dir": "C:\\Users\\aswin\\generated-mcp\\petstore-demo",
  "warnings": []
}
```

**Collision protection:** If you run this twice, the second call returns `isError: true` listing the conflicting files. Use `dry_run: true` to preview, then `force: true` to overwrite intentionally.

---

## Tool 4: `generate_mcp_config`

**What it does:** Writes the `.mcp.json` config so Claude Code or Claude Desktop can install and use the generated server. Reads the manifest to auto-populate auth env vars if needed.

**Input:**
```json
{
  "output_dir": "~/generated-mcp/petstore-demo",
  "server_name": "petstore-api"
}
```

**Generated `.mcp.json`:**
```json
{
  "mcpServers": {
    "petstore-api": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "C:\\Users\\aswin\\generated-mcp\\petstore-demo"
    }
  }
}
```

For a spec with Bearer auth, the output would include `"env": { "BEARER_TOKEN": "" }` automatically — the manifest told `generate_mcp_config` what env var name to use.

---

## Tool 5: `run_validation`

**What it does:** Compiles the generated server (`tsc --noEmit`), builds it, starts it as a child process, then sends it an MCP `initialize` request followed by `tools/list`. Reports per-phase timing.

**Input:**
```json
{ "output_dir": "~/generated-mcp/petstore-demo" }
```

**MCP probe result (live run against the generated server):**
```
tool_count: 5
 - list_pets      | List all pets
 - create_pets    | Create a pet
 - show_pet_by_id | Info for a specific pet
 - delete_pet     | Delete a pet
 - list_owners    | List all owners
```

The generated server responded to the MCP protocol correctly. It registers 5 tools, each with the name and description from the original spec.

**Validation checks:**
```json
{
  "passed": true,
  "checks": [
    { "name": "npm_install",        "passed": true,  "skipped": true,  "output": "dependencies already installed" },
    { "name": "typescript_compile", "passed": true,  "elapsedMs": 812, "output": "" },
    { "name": "server_starts",      "passed": true,  "elapsedMs": 420  },
    { "name": "tools_list",         "passed": true,  "elapsedMs": 580, "output": "5 tool(s) registered" }
  ]
}
```

---

## Tool 6: `generate_readme`

**What it does:** Writes a README for the generated server. Reads the manifest (no re-parsing the spec).

**Input:**
```json
{
  "output_dir": "~/generated-mcp/petstore-demo",
  "server_name": "petstore-api"
}
```

**Generated `README.md` (excerpt):**
```markdown
# petstore-api

MCP server for **petstore-api** — generated by api-to-mcp-generator.

## Installation
npm install && npm run build

## Available Tools (5)
- `list_pets`
- `create_pets`
- `show_pet_by_id`
- `delete_pet`
- `list_owners`

## API Base URL
`https://petstore.example.com/v1`
```

---

## What the generated server looks like from Claude's perspective

Once installed via `.mcp.json`, Claude sees it as 5 usable tools:

```
Claude: "List the first 3 pets from the petstore API"
→ calls list_pets({ limit: 3 })
→ GET https://petstore.example.com/v1/pets?limit=3
→ returns JSON response

Claude: "Create a pet named Fido with tag 'dog'"
→ calls create_pets({ body: { name: "Fido", tag: "dog" } })
→ POST https://petstore.example.com/v1/pets  { name: "Fido", tag: "dog" }
→ returns created pet
```

---

## Auth example: what changes for a protected API

For a spec with Bearer auth (like the stripe-subset fixture), the output differs in three places:

**1. `parse_openapi_spec` detects the scheme:**
```json
"detectedAuthSchemes": [{ "type": "bearer", "envVar": "BEARER_TOKEN", "headerName": "Authorization" }]
```

**2. `src/client.ts` injects the token automatically:**
```typescript
headers: {
  ...(process.env.BEARER_TOKEN ? { "Authorization": `Bearer ${process.env.BEARER_TOKEN}` } : {})
}
```

**3. `.env.example` tells you what to set:**
```
BEARER_TOKEN=your-token-here
```

The FDE sets `BEARER_TOKEN` in the `.mcp.json` env block or their shell, and every API call is authenticated. Zero manual wiring.

---

## Feature summary

| Feature | What it solves |
|---------|---------------|
| 6 composable tools | Each tool is useful standalone — parse to explore, dry_run to preview, schemas to inspect |
| IR normalization layer | Handles oneOf, allOf, anyOf, nullable, circular refs, missing operationIds — deterministic output |
| Session cache | Same spec across 6 tool calls = 1 parse, not 6 |
| Auth auto-detection | Reads securitySchemes → injects env var auth in generated client, no manual wiring |
| `dry_run` flag | Preview before committing to disk |
| `force` flag | Overwrite existing output intentionally (bypasses collision check only, not security guards) |
| Generation manifest | Provenance record: what spec, what hash, what tools, what options. Enables future diffing |
| SSRF protection | IPv4 + IPv6 blocklist, https-only, redirect-following disabled |
| Path traversal protection | Unix /etc + Windows C:\Windows blocked; output must be within home/cwd |
| Tag-based grouping | Navigate large specs (Stripe has 50+ tags) — filter by tag, not by listing 400 operation IDs |
| Op count guard | >50 warns, >100 refuses — prevents generating a 400-tool MCP server that Claude can't use |
| tsc validation | Generated server must compile in strict mode before validation passes |
| MCP probe | Actually starts the server and sends it an MCP initialize + tools/list — proves it works |
