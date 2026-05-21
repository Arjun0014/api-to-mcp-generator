import type { OpenAPIV3 } from "openapi-types";
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

// ─── Public API ───────────────────────────────────────────────────────────────

export function normalizeSpec(
  doc: OpenAPIV3.Document,
  filterOperationIds?: string[]
): { operations: NormalizedOperation[]; warnings: string[] } {
  const ctx = makeNormCtx();
  const warnings: string[] = [];
  const globalAuth = detectGlobalAuth(doc);
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

  return { operations, warnings };
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
    }
  }

  return schemes;
}

// Exported for unit testing
export function normalizeSchema(schema: OpenAPIV3.SchemaObject, ctx: NormCtx): NormalizedSchema {
  if (ctx.depth > 20) {
    return { kind: "unknown", warning: `schema too deeply nested (depth: ${ctx.depth})` };
  }

  if (ctx.visited.has(schema as object)) {
    return { kind: "unknown", warning: "circular reference detected — manual review required" };
  }
  ctx.visited.set(schema as object, true);

  const child: NormCtx = { ...ctx, depth: ctx.depth + 1 };
  return normalizeSchemaInner(schema, child);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function isRefObject(obj: unknown): obj is OpenAPIV3.ReferenceObject {
  return typeof obj === "object" && obj !== null && "$ref" in obj;
}

function detectGlobalAuth(doc: OpenAPIV3.Document): NormalizedAuth {
  const schemes = detectAuthSchemes(doc);
  if (schemes.length === 0) return { type: "none" };
  const first = schemes[0]!;
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
  // Collision is implicit: the seen set deduplicated it
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

  return {
    toolName,
    operationId,
    method,
    path,
    summary: op.summary ?? `${method.toUpperCase()} ${path}`,
    description: op.description,
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
  // Non-string enum — treat as union of literals (represented as unknown for v1)
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
  // allOf with discriminator: complex polymorphism — emit union + warning
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
