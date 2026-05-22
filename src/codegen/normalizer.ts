import type { OpenAPIV3, OpenAPIV2 } from "openapi-types";
import type {
  NormalizedOperation,
  NormalizedSchema,
  NormalizedParameter,
  NormalizedRequestBody,
  NormalizedResponse,
  NormalizedAuth,
  NormCtx,
} from "../ir/types.js";
import { makeNormCtx } from "../ir/types.js";
import type { DetectedAuthScheme } from "../types.js";

const METHODS = ["get", "post", "put", "delete", "patch"] as const;
// Guard against code injection via spec-derived schema names embedded as TypeScript identifiers.
const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

// ─── Public API ───────────────────────────────────────────────────────────────

// Dispatcher: detects OpenAPI version and routes to the appropriate normalizer.
// Returns { operations, namedSchemas, warnings }.
export function normalizeDoc(
  doc: OpenAPIV3.Document | OpenAPIV2.Document
): { operations: NormalizedOperation[]; namedSchemas: Record<string, NormalizedSchema>; warnings: string[] } {
  if ((doc as OpenAPIV2.Document).swagger === "2.0") {
    return normalizeSwagger2Doc(doc as OpenAPIV2.Document);
  }
  return normalizeSpec(doc as OpenAPIV3.Document);
}

// OpenAPI 3.x normalizer.
// Two-pass design: Pass 1 populates componentNames WeakMap from components.schemas
// (required BEFORE Pass 2), so circular detection can emit { kind:"lazy" } correctly.
export function normalizeSpec(
  doc: OpenAPIV3.Document,
  filterOperationIds?: string[]
): { operations: NormalizedOperation[]; namedSchemas: Record<string, NormalizedSchema>; warnings: string[] } {
  const ctx = makeNormCtx();
  const warnings: string[] = [];
  const globalAuth = detectGlobalAuth(doc);

  // Pass 1: register all named component schemas so circular detection can name them.
  // Uses a fresh visited WeakSet per definition to avoid stale entries that would
  // cause false-positive z.lazy() emission on body parameters in Pass 2.
  const namedSchemas: Record<string, NormalizedSchema> = {};
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    if (!schema || isRefObject(schema)) continue;
    if (!VALID_IDENTIFIER.test(name)) continue; // skip non-identifier names (code injection guard)
    const schemaObj = schema as OpenAPIV3.SchemaObject;
    ctx.componentNames.set(schemaObj as object, name);
    // Use a per-definition ctx (fresh visited) so cycle-detected entries don't bleed into Pass 2.
    const defCtx: NormCtx = { visited: new WeakSet(), componentNames: ctx.componentNames, depth: 0, seenToolNames: ctx.seenToolNames };
    namedSchemas[name] = normalizeSchema(schemaObj, defCtx);
  }

  // Pass 2: normalize operations (componentNames is now populated).
  const operations: NormalizedOperation[] = [];
  for (const [pathStr, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || isRefObject(pathItem)) continue;
    const item = pathItem as OpenAPIV3.PathItemObject;

    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;

      const normalized = normalizeOperation(op, method, pathStr, doc, ctx, globalAuth);

      if (filterOperationIds && !filterOperationIds.includes(normalized.operationId)) {
        continue;
      }

      if (normalized.warnings.length > 0) warnings.push(...normalized.warnings);
      operations.push(normalized);
    }
  }

  return { operations, namedSchemas, warnings };
}

export function detectAuthSchemes(doc: OpenAPIV3.Document): DetectedAuthScheme[] {
  const schemes: DetectedAuthScheme[] = [];
  const securitySchemes = doc.components?.securitySchemes ?? {};

  for (const [name, scheme] of Object.entries(securitySchemes)) {
    if (!scheme || isRefObject(scheme)) continue;
    const s = scheme as OpenAPIV3.SecuritySchemeObject;

    if (s.type === "http" && s.scheme === "bearer") {
      schemes.push({ name, type: "bearer", envVar: "BEARER_TOKEN", headerName: "Authorization" });
    } else if (s.type === "apiKey" && s.in === "header") {
      schemes.push({ name, type: "api_key_header", envVar: "API_KEY_HEADER", headerName: s.name });
    } else if (s.type === "apiKey" && s.in === "query") {
      schemes.push({ name, type: "api_key_query", envVar: "API_KEY_QUERY", queryParam: s.name });
    } else if (s.type === "oauth2") {
      const flows = (s as OpenAPIV3.OAuth2SecurityScheme).flows;
      const ccFlow = flows?.clientCredentials;
      if (ccFlow) {
        schemes.push({
          name,
          type: "oauth_client_credentials",
          envVar: "OAUTH_CLIENT_ID",
          tokenEndpoint: ccFlow.tokenUrl,
        });
      }
    }
  }

  return schemes;
}

// Exported for unit testing.
// Uses a per-traversal `visited` WeakSet to detect true circular references
// (the same object appearing as its own ancestor) without false-positiving on
// shared schemas (the same object reused in multiple unrelated places).
// When a cycle is detected AND the schema has a registered name in ctx.componentNames,
// emits { kind: "lazy", refName } instead of { kind: "unknown" }.
export function normalizeSchema(schema: OpenAPIV3.SchemaObject, ctx: NormCtx): NormalizedSchema {
  if (ctx.depth > 20) {
    return { kind: "unknown", warning: `schema too deeply nested (depth: ${ctx.depth})` };
  }

  // ctx.visited tracks the current *ancestor chain* — add before recursing, remove after.
  // This distinguishes true cycles from legitimate shared schemas.
  if (ctx.visited.has(schema as object)) {
    const refName = ctx.componentNames.get(schema as object);
    if (refName) {
      return { kind: "lazy", refName };
    }
    return { kind: "unknown", warning: "circular reference detected — manual review required" };
  }
  ctx.visited.add(schema as object);

  const child: NormCtx = { ...ctx, depth: ctx.depth + 1 };
  const result = normalizeSchemaInner(schema, child);

  // Remove from the ancestor chain after recursion so sibling schemas can reuse the same object
  ctx.visited.delete(schema as object);

  return result;
}

// ─── Swagger 2.0 adapter ──────────────────────────────────────────────────────

function normalizeSwagger2Doc(
  doc: OpenAPIV2.Document
): { operations: NormalizedOperation[]; namedSchemas: Record<string, NormalizedSchema>; warnings: string[] } {
  const ctx = makeNormCtx();
  const warnings: string[] = [];
  const globalAuth = detectGlobalAuthV2(doc);

  // Pass 1: register named definitions for z.lazy() support.
  // Uses fresh visited per definition (same as V3 path) to prevent stale cycle entries.
  const namedSchemas: Record<string, NormalizedSchema> = {};
  const defsRaw = (doc as unknown as Record<string, unknown>).definitions as Record<string, OpenAPIV2.SchemaObject> | undefined ?? {};
  for (const [name, schema] of Object.entries(defsRaw)) {
    if (!schema || isRefObject(schema)) continue;
    if (!VALID_IDENTIFIER.test(name)) continue; // code injection guard
    ctx.componentNames.set(schema as object, name);
    const defCtx: NormCtx = { visited: new WeakSet(), componentNames: ctx.componentNames, depth: 0, seenToolNames: ctx.seenToolNames };
    namedSchemas[name] = normalizeSchemaV2(schema as OpenAPIV2.SchemaObject, defCtx);
  }

  // Swagger 2.0 global consumes/produces defaults
  const globalConsumes = doc.consumes ?? ["application/json"];

  // Pass 2: normalize operations.
  const operations: NormalizedOperation[] = [];
  for (const [pathStr, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || isRefObject(pathItem)) continue;

    for (const method of METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OpenAPIV2.OperationObject | undefined;
      if (!op) continue;

      const normalized = normalizeOperationV2(op, method, pathStr, doc, ctx, globalAuth, globalConsumes);
      if (normalized.warnings.length > 0) warnings.push(...normalized.warnings);
      operations.push(normalized);
    }
  }

  return { operations, namedSchemas, warnings };
}

export function detectAuthSchemesV2(doc: OpenAPIV2.Document): DetectedAuthScheme[] {
  const schemes: DetectedAuthScheme[] = [];
  const defs = (doc as unknown as Record<string, unknown>).securityDefinitions as Record<string, Record<string, unknown>> | undefined;
  if (!defs) return schemes;

  for (const [name, scheme] of Object.entries(defs)) {
    if (!scheme) continue;
    const type = scheme["type"] as string | undefined;
    const inField = scheme["in"] as string | undefined;

    if (type === "basic") {
      // basic auth → treat as bearer (FDE will use HTTP auth header)
      schemes.push({ name, type: "bearer", envVar: "BEARER_TOKEN", headerName: "Authorization" });
    } else if (type === "apiKey" && inField === "header") {
      const headerName = (scheme["name"] as string | undefined) ?? "X-API-Key";
      schemes.push({ name, type: "api_key_header", envVar: "API_KEY_HEADER", headerName });
    } else if (type === "apiKey" && inField === "query") {
      const queryParam = (scheme["name"] as string | undefined) ?? "api_key";
      schemes.push({ name, type: "api_key_query", envVar: "API_KEY_QUERY", queryParam });
    } else if (type === "oauth2") {
      const flow = scheme["flow"] as string | undefined;
      // "application" is Swagger 2.0's equivalent of clientCredentials
      if (flow === "application") {
        const tokenUrl = (scheme["tokenUrl"] as string | undefined) ?? "";
        schemes.push({ name, type: "oauth_client_credentials", envVar: "OAUTH_CLIENT_ID", tokenEndpoint: tokenUrl });
      }
    }
  }

  return schemes;
}

// Normalize a Swagger 2.0 schema object.
// Key difference from V3: uses `x-nullable` extension instead of `nullable` field.
function normalizeSchemaV2(schema: OpenAPIV2.SchemaObject, ctx: NormCtx): NormalizedSchema {
  if (ctx.depth > 20) {
    return { kind: "unknown", warning: `schema too deeply nested (depth: ${ctx.depth})` };
  }

  if (ctx.visited.has(schema as object)) {
    const refName = ctx.componentNames.get(schema as object);
    if (refName) return { kind: "lazy", refName };
    return { kind: "unknown", warning: "circular reference detected — manual review required" };
  }
  ctx.visited.add(schema as object);

  const child: NormCtx = { ...ctx, depth: ctx.depth + 1 };
  const result = normalizeSchemaV2Inner(schema, child);
  ctx.visited.delete(schema as object);
  return result;
}

function normalizeSchemaV2Inner(schema: OpenAPIV2.SchemaObject, ctx: NormCtx): NormalizedSchema {
  // x-nullable extension (Swagger 2.0) — standard nullable field is not in the spec
  const ext = schema as unknown as Record<string, unknown>;
  const nullable = ext["x-nullable"] === true;

  if (schema.enum !== undefined) {
    if (schema.type === "string" || schema.type === undefined) {
      const values = (schema.enum as unknown[]).filter((v): v is string => typeof v === "string");
      return { kind: "string", enum: values, nullable };
    }
    return { kind: "unknown", warning: `Non-string enum type "${String(schema.type)}" not supported` };
  }

  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    const variants = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]
      .filter(s => !isRefObject(s))
      .map(s => normalizeSchemaV2(s as OpenAPIV2.SchemaObject, ctx));
    if (variants.length === 0) return { kind: "unknown", warning: "empty oneOf/anyOf" };
    if (variants.length === 1) return variants[0]!;
    return { kind: "union", variants, nullable };
  }

  if (schema.allOf !== undefined) {
    const parts = (schema.allOf as OpenAPIV2.SchemaObject[])
      .filter(s => !isRefObject(s))
      .map(s => normalizeSchemaV2(s, ctx));
    if (parts.length === 0) return { kind: "unknown", warning: "empty allOf" };
    if (parts.length === 1) return parts[0]!;
    return { kind: "intersection", parts };
  }

  switch (schema.type) {
    case "string":  return { kind: "string", format: schema.format, nullable };
    case "integer": return { kind: "number", integer: true, nullable };
    case "number":  return { kind: "number", integer: false, nullable };
    case "boolean": return { kind: "boolean", nullable };
    case "array": {
      const items = schema.items;
      if (!items || isRefObject(items)) {
        return { kind: "array", items: { kind: "unknown", warning: "array items not specified" }, nullable };
      }
      return { kind: "array", items: normalizeSchemaV2(items as OpenAPIV2.SchemaObject, ctx), nullable };
    }
    case "object":
    default: {
      if (schema.properties !== undefined || schema.type === "object") {
        const requiredFields = new Set(schema.required ?? []);
        const properties: Record<string, { schema: NormalizedSchema; required: boolean }> = {};
        for (const [key, value] of Object.entries(schema.properties ?? {})) {
          if (isRefObject(value)) continue;
          properties[key] = {
            schema: normalizeSchemaV2(value as OpenAPIV2.SchemaObject, ctx),
            required: requiredFields.has(key),
          };
        }
        return { kind: "object", properties, nullable };
      }
      return { kind: "unknown", warning: `Unrecognized schema type: ${JSON.stringify(schema.type ?? "(none)")}` };
    }
  }
}

function normalizeOperationV2(
  op: OpenAPIV2.OperationObject,
  method: (typeof METHODS)[number],
  path: string,
  doc: OpenAPIV2.Document,
  ctx: NormCtx,
  globalAuth: NormalizedAuth,
  globalConsumes: string[]
): NormalizedOperation {
  const { toolName, operationId, generated } = toToolName(
    op.operationId,
    method,
    path,
    ctx.seenToolNames
  );

  const warnings: string[] = [];
  if (generated) {
    warnings.push(`Generated toolName "${toolName}" from ${method.toUpperCase()} ${path} (no operationId)`);
  }

  const params = (op.parameters ?? []).filter(
    (p): p is OpenAPIV2.GeneralParameterObject => !isRefObject(p)
  );

  const formDataParams = params.filter(p => p.in === "formData");
  if (formDataParams.length > 0) {
    for (const p of formDataParams) {
      warnings.push(`formData parameter "${p.name}" is not supported — manual implementation required`);
    }
  }

  const parameters: NormalizedParameter[] = params
    .filter(p => p.in !== "body" && p.in !== "formData" && p.in !== "cookie")
    .map(p => {
      const schema: OpenAPIV2.SchemaObject = p.schema
        ? (isRefObject(p.schema) ? {} as OpenAPIV2.SchemaObject : p.schema as OpenAPIV2.SchemaObject)
        : buildSchemaFromParam(p);
      return {
        name: p.name,
        in: p.in as "query" | "path" | "header",
        required: p.required === true || p.in === "path",
        schema: normalizeSchemaV2(schema, ctx),
        description: p.description,
      };
    });

  // Body parameter (Swagger 2.0 uses `in: body` instead of requestBody)
  const bodyParam = params.find(p => p.in === "body");
  const opConsumes = (op as unknown as Record<string, unknown>).consumes as string[] | undefined;
  const effectiveConsumes = opConsumes ?? globalConsumes;
  let requestBody: NormalizedRequestBody | undefined;
  if (bodyParam && bodyParam.schema && !isRefObject(bodyParam.schema)) {
    requestBody = {
      required: bodyParam.required === true,
      schema: normalizeSchemaV2(bodyParam.schema as OpenAPIV2.SchemaObject, ctx),
      contentType: effectiveConsumes.includes("application/json") ? "application/json" : effectiveConsumes[0] ?? "application/json",
    };
  }

  const responses = normalizeResponsesV2(op.responses ?? {}, ctx);
  const auth = resolveAuthV2(op, globalAuth);
  const tags = op.tags ?? [];

  return {
    toolName,
    operationId,
    method,
    path,
    summary: op.summary ?? `${method.toUpperCase()} ${path}`,
    description: op.description,
    tags,
    parameters,
    requestBody,
    responses,
    auth,
    warnings,
  };
}

function normalizeResponsesV2(
  responses: OpenAPIV2.ResponsesObject,
  ctx: NormCtx
): NormalizedResponse[] {
  return Object.entries(responses).map(([code, response]) => {
    if (isRefObject(response)) return { statusCode: code };
    const resp = response as OpenAPIV2.ResponseObject;
    // Swagger 2.0: response schema is at resp.schema, not resp.content[...].schema
    const rawSchema = resp.schema && !isRefObject(resp.schema)
      ? (resp.schema as OpenAPIV2.SchemaObject)
      : undefined;
    return {
      statusCode: code,
      schema: rawSchema ? normalizeSchemaV2(rawSchema, ctx) : undefined,
      description: resp.description,
    };
  });
}

function detectGlobalAuthV2(doc: OpenAPIV2.Document): NormalizedAuth {
  const schemes = detectAuthSchemesV2(doc);
  if (schemes.length === 0) return { type: "none" };
  const first = schemes[0]!;
  return {
    type: first.type === "oauth_client_credentials" ? "bearer" : first.type,
    envVar: first.envVar,
    headerName: first.headerName,
    queryParam: first.queryParam,
  };
}

function resolveAuthV2(
  op: OpenAPIV2.OperationObject,
  globalAuth: NormalizedAuth
): NormalizedAuth {
  const opSecurity = (op as unknown as Record<string, unknown>).security as Array<Record<string, string[]>> | undefined;
  if (opSecurity === undefined) return globalAuth;
  if (opSecurity.length === 0) return { type: "none" };
  return globalAuth;
}

// Helper: build a minimal schema from a Swagger 2.0 non-body parameter
function buildSchemaFromParam(p: OpenAPIV2.GeneralParameterObject): OpenAPIV2.SchemaObject {
  const schema: Record<string, unknown> = {};
  const ext = p as unknown as Record<string, unknown>;
  if (ext["type"]) schema["type"] = ext["type"];
  if (ext["format"]) schema["format"] = ext["format"];
  if (ext["enum"]) schema["enum"] = ext["enum"];
  return schema as OpenAPIV2.SchemaObject;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function isRefObject(obj: unknown): obj is OpenAPIV3.ReferenceObject {
  return typeof obj === "object" && obj !== null && "$ref" in obj;
}

function detectGlobalAuth(doc: OpenAPIV3.Document): NormalizedAuth {
  const schemes = detectAuthSchemes(doc);
  if (schemes.length === 0) return { type: "none" };
  const first = schemes[0]!;
  // oauth_client_credentials at operation level is handled in resolveAuth via per-op security
  if (first.type === "oauth_client_credentials") {
    return { type: "bearer", envVar: "BEARER_TOKEN", headerName: "Authorization" };
  }
  return {
    type: first.type,
    envVar: first.envVar,
    headerName: first.headerName,
    queryParam: first.queryParam,
  };
}

function resolveAuth(
  op: OpenAPIV3.OperationObject,
  doc: OpenAPIV3.Document,
  globalAuth: NormalizedAuth
): NormalizedAuth {
  if (op.security === undefined) return globalAuth;
  if (op.security.length === 0) return { type: "none" };

  const securitySchemes = doc.components?.securitySchemes ?? {};
  for (const req of op.security) {
    for (const schemeName of Object.keys(req)) {
      const scheme = securitySchemes[schemeName];
      if (!scheme || isRefObject(scheme)) continue;
      const s = scheme as OpenAPIV3.SecuritySchemeObject;
      if (s.type === "http" && s.scheme === "bearer") {
        return { type: "bearer", envVar: "BEARER_TOKEN", headerName: "Authorization" };
      }
      if (s.type === "apiKey" && s.in === "header") {
        return { type: "api_key_header", envVar: "API_KEY_HEADER", headerName: s.name };
      }
      if (s.type === "apiKey" && s.in === "query") {
        return { type: "api_key_query", envVar: "API_KEY_QUERY", queryParam: s.name };
      }
    }
  }
  return globalAuth;
}

function generateRawOperationId(method: string, path: string): string {
  const cleanPath = path
    .replace(/\{(\w+)\}/g, "by_$1")
    .replace(/\//g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
  return `${method.toLowerCase()}_${cleanPath}`;
}

function toToolName(
  rawId: string | undefined,
  method: string,
  path: string,
  seen: Set<string>
): { toolName: string; operationId: string; generated: boolean } {
  const generated = rawId === undefined;
  const operationId = rawId ?? generateRawOperationId(method, path);

  let base: string;
  if (rawId) {
    base = rawId
      .replace(/([A-Z])/g, "_$1")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/__+/g, "_")
      .replace(/^_|_$/g, "");
  } else {
    base = generateRawOperationId(method, path);
  }

  if (!base) base = "operation";

  if (!seen.has(base)) {
    seen.add(base);
    return { toolName: base, operationId, generated };
  }

  let n = 2;
  while (seen.has(`${base}_${n}`)) n++;
  const deduped = `${base}_${n}`;
  seen.add(deduped);
  return { toolName: deduped, operationId, generated };
}

function normalizeOperation(
  op: OpenAPIV3.OperationObject,
  method: (typeof METHODS)[number],
  path: string,
  doc: OpenAPIV3.Document,
  ctx: NormCtx,
  globalAuth: NormalizedAuth
): NormalizedOperation {
  const { toolName, operationId, generated } = toToolName(
    op.operationId,
    method,
    path,
    ctx.seenToolNames
  );

  const warnings: string[] = [];
  if (generated) {
    warnings.push(`Generated toolName "${toolName}" from ${method.toUpperCase()} ${path} (no operationId)`);
  }
  if (!generated && operationId !== undefined) {
    const expectedBase = op.operationId!
      .replace(/([A-Z])/g, "_$1")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/__+/g, "_")
      .replace(/^_|_$/g, "");
    if (toolName !== expectedBase) {
      warnings.push(`toolName "${toolName}" deduplicated from "${expectedBase}" (collision)`);
    }
  }

  const rawParams = (op.parameters ?? []).filter(
    (p): p is OpenAPIV3.ParameterObject => !isRefObject(p)
  );
  const parameters = normalizeParameters(rawParams, ctx);

  const rawBody = op.requestBody && !isRefObject(op.requestBody)
    ? (op.requestBody as OpenAPIV3.RequestBodyObject)
    : undefined;
  const requestBody = rawBody ? normalizeRequestBody(rawBody, ctx) : undefined;

  const responses = normalizeResponses(op.responses ?? {}, ctx);
  const auth = resolveAuth(op, doc, globalAuth);
  const tags = op.tags ?? [];

  return {
    toolName,
    operationId,
    method,
    path,
    summary: op.summary ?? `${method.toUpperCase()} ${path}`,
    description: op.description,
    tags,
    parameters,
    requestBody,
    responses,
    auth,
    warnings,
  };
}

function normalizeParameters(
  params: OpenAPIV3.ParameterObject[],
  ctx: NormCtx
): NormalizedParameter[] {
  return params
    .filter(p => p.in !== "cookie") // cookies not supported in v1
    .map(p => {
      const rawSchema = p.schema && !isRefObject(p.schema)
        ? (p.schema as OpenAPIV3.SchemaObject)
        : {};
      return {
        name: p.name,
        in: p.in as "query" | "path" | "header",
        required: p.required === true || p.in === "path",
        schema: normalizeSchema(rawSchema, ctx),
        description: p.description,
      };
    });
}

function normalizeRequestBody(
  body: OpenAPIV3.RequestBodyObject,
  ctx: NormCtx
): NormalizedRequestBody {
  const jsonContent = body.content?.["application/json"];
  const rawSchema = jsonContent?.schema && !isRefObject(jsonContent.schema)
    ? (jsonContent.schema as OpenAPIV3.SchemaObject)
    : {};

  return {
    required: body.required === true,
    schema: normalizeSchema(rawSchema, ctx),
    contentType: "application/json",
  };
}

function normalizeResponses(
  responses: OpenAPIV3.ResponsesObject,
  ctx: NormCtx
): NormalizedResponse[] {
  return Object.entries(responses).map(([code, response]) => {
    if (isRefObject(response)) return { statusCode: code };
    const resp = response as OpenAPIV3.ResponseObject;
    const jsonContent = resp.content?.["application/json"];
    const rawSchema = jsonContent?.schema && !isRefObject(jsonContent.schema)
      ? (jsonContent.schema as OpenAPIV3.SchemaObject)
      : undefined;
    return {
      statusCode: code,
      schema: rawSchema ? normalizeSchema(rawSchema, ctx) : undefined,
      description: resp.description,
    };
  });
}

// ─── Schema normalization (dispatcher + per-type helpers) ─────────────────────

function normalizeSchemaInner(schema: OpenAPIV3.SchemaObject, ctx: NormCtx): NormalizedSchema {
  const nullable = schema.nullable === true;

  if (schema.enum !== undefined) return normalizeEnumSchema(schema, nullable);
  if (schema.oneOf !== undefined) return normalizeOneOfSchema(schema, nullable, ctx);
  if (schema.anyOf !== undefined) return normalizeAnyOfSchema(schema, nullable, ctx);
  if (schema.allOf !== undefined) return normalizeAllOfSchema(schema, nullable, ctx);

  switch (schema.type) {
    case "string":  return normalizeStringSchema(schema, nullable);
    case "integer": return { kind: "number", integer: true, nullable };
    case "number":  return { kind: "number", integer: false, nullable };
    case "boolean": return { kind: "boolean", nullable };
    case "array":   return normalizeArraySchema(schema, nullable, ctx);
    case "object":  return normalizeObjectSchema(schema, nullable, ctx);
    default:
      // Implicit object: has properties but no explicit type
      if (schema.properties !== undefined) return normalizeObjectSchema(schema, nullable, ctx);
      return { kind: "unknown", warning: `Unrecognized schema type: ${JSON.stringify(schema.type ?? "(none)")}` };
  }
}

function normalizeEnumSchema(schema: OpenAPIV3.SchemaObject, nullable: boolean): NormalizedSchema {
  if (schema.type === "string" || schema.type === undefined) {
    const values = (schema.enum as unknown[]).filter((v): v is string => typeof v === "string");
    return { kind: "string", enum: values, nullable };
  }
  return { kind: "unknown", warning: `Non-string enum type "${schema.type}" not supported` };
}

function normalizeStringSchema(schema: OpenAPIV3.SchemaObject, nullable: boolean): NormalizedSchema {
  return { kind: "string", format: schema.format, nullable };
}

function normalizeArraySchema(
  schema: OpenAPIV3.SchemaObject,
  nullable: boolean,
  ctx: NormCtx
): NormalizedSchema {
  const arraySchema = schema as OpenAPIV3.ArraySchemaObject;
  if (!arraySchema.items) {
    return { kind: "array", items: { kind: "unknown", warning: "array items not specified" }, nullable };
  }
  const rawItems = isRefObject(arraySchema.items)
    ? ({} as OpenAPIV3.SchemaObject)
    : (arraySchema.items as OpenAPIV3.SchemaObject);
  return { kind: "array", items: normalizeSchema(rawItems, ctx), nullable };
}

function normalizeObjectSchema(
  schema: OpenAPIV3.SchemaObject,
  nullable: boolean,
  ctx: NormCtx
): NormalizedSchema {
  const requiredFields = new Set(schema.required ?? []);
  const properties: Record<string, { schema: NormalizedSchema; required: boolean }> = {};

  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (isRefObject(value)) continue;
    properties[key] = {
      schema: normalizeSchema(value as OpenAPIV3.SchemaObject, ctx),
      required: requiredFields.has(key),
    };
  }

  return { kind: "object", properties, nullable };
}

function normalizeOneOfSchema(
  schema: OpenAPIV3.SchemaObject,
  nullable: boolean,
  ctx: NormCtx
): NormalizedSchema {
  const variants = (schema.oneOf ?? [])
    .filter(s => !isRefObject(s))
    .map(s => normalizeSchema(s as OpenAPIV3.SchemaObject, ctx));
  if (variants.length === 0) return { kind: "unknown", warning: "empty oneOf" };
  if (variants.length === 1) return variants[0]!;
  return { kind: "union", variants, nullable };
}

function normalizeAnyOfSchema(
  schema: OpenAPIV3.SchemaObject,
  nullable: boolean,
  ctx: NormCtx
): NormalizedSchema {
  const variants = (schema.anyOf ?? [])
    .filter(s => !isRefObject(s))
    .map(s => normalizeSchema(s as OpenAPIV3.SchemaObject, ctx));
  if (variants.length === 0) return { kind: "unknown", warning: "empty anyOf" };
  if (variants.length === 1) return variants[0]!;
  return { kind: "union", variants, nullable };
}

function normalizeAllOfSchema(
  schema: OpenAPIV3.SchemaObject,
  nullable: boolean,
  ctx: NormCtx
): NormalizedSchema {
  if (schema.discriminator) {
    return {
      kind: "unknown",
      warning: `allOf with discriminator "${schema.discriminator.propertyName}" — manual review required`,
    };
  }

  const parts = (schema.allOf ?? [])
    .filter(s => !isRefObject(s))
    .map(s => normalizeSchema(s as OpenAPIV3.SchemaObject, ctx));

  if (parts.length === 0) return { kind: "unknown", warning: "empty allOf" };
  if (parts.length === 1) return parts[0]!;
  return { kind: "intersection", parts };
}
