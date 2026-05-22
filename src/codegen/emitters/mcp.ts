import type { NormalizedOperation, NormalizedSchema } from "../../ir/types.js";
import type { GeneratedServer } from "../../types.js";
import type { EmitterContext } from "./index.js";
import {
  generatedFileHeader,
  authEnvVarComment,
  envExampleContent,
  generatedPackageJson,
  generatedTsConfig,
} from "../templates.js";

const VALID_ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;

export class MCPEmitter {
  emit(ir: NormalizedOperation[], ctx: EmitterContext): GeneratedServer {
    const warnings: string[] = [];

    // Collect operation-level warnings
    for (const op of ir) {
      warnings.push(...op.warnings);
    }

    const authEnvVar = ctx.authEnvVar ?? defaultEnvVar(ctx.authType);

    // Validate envVar is a legal identifier before embedding it in generated TypeScript
    if (authEnvVar && !VALID_ENV_VAR.test(authEnvVar)) {
      throw new Error(
        `auth_env_var must be a valid environment variable name (uppercase letters, digits, underscores). Got: ${JSON.stringify(authEnvVar)}`
      );
    }

    const files: Record<string, string> = {
      "src/index.ts": this.buildIndexTs(ir, ctx, authEnvVar),
      "src/client.ts": this.buildClientTs(ctx, authEnvVar),
      "package.json": generatedPackageJson(ctx.serverName),
      "tsconfig.json": generatedTsConfig(),
      ".env.example": envExampleContent(ctx.authType, authEnvVar),
    };

    return { files, warnings };
  }

  private buildIndexTs(
    ir: NormalizedOperation[],
    ctx: EmitterContext,
    authEnvVar: string
  ): string {
    const header = generatedFileHeader(ctx.serverName);

    // Pre-pass: collect all { kind:"lazy" } schema refNames referenced in this IR,
    // then emit hoisted z.lazy() const declarations for them.
    const lazyConsts = this.buildLazyConsts(ir, ctx);
    const zodConsts = ir.map(op => this.buildZodConst(op)).join("\n\n");
    const toolDefs = ir.map(op => this.buildToolDef(op)).join(",\n    ");
    const cases = ir.map(op => this.buildCase(op, ctx)).join("\n      ");

    return `${header}
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ZodError } from "zod";
import { client } from "./client.js";

const server = new Server(
  { name: ${JSON.stringify(ctx.serverName)}, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

${lazyConsts}${zodConsts}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ${toolDefs}
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      ${cases}
      default:
        return {
          content: [{ type: "text" as const, text: \`Unknown tool: \${name}\` }],
          isError: true,
        };
    }
  } catch (error) {
    const message =
      error instanceof ZodError
        ? \`Invalid input: \${error.errors.map(e => \`\${e.path.join(".")}: \${e.message}\`).join(", ")}\`
        : error instanceof Error
        ? error.message
        : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
});

${RUNTIME_HELPERS}

void (async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
`;
  }

  // DFS over namedSchemas AND operation IR to find all { kind:"lazy" } refNames,
  // then emit hoisted z.lazy() const declarations.
  // Must cover operation IR too: lazy refs can appear in op params/body/responses
  // even if not cross-referenced from another named schema.
  private buildLazyConsts(ir: NormalizedOperation[], ctx: EmitterContext): string {
    const namedSchemas = ctx.namedSchemas ?? {};
    const lazyRefNames = new Set<string>();

    // Collect from named component schemas
    for (const schema of Object.values(namedSchemas)) {
      collectLazyRefs(schema, lazyRefNames);
    }

    // Also collect from operation parameter/requestBody/response schemas
    for (const op of ir) {
      for (const param of op.parameters) collectLazyRefs(param.schema, lazyRefNames);
      if (op.requestBody) collectLazyRefs(op.requestBody.schema, lazyRefNames);
      for (const resp of op.responses) {
        if (resp.schema) collectLazyRefs(resp.schema, lazyRefNames);
      }
    }

    if (lazyRefNames.size === 0) return "";

    const consts: string[] = [];
    for (const refName of lazyRefNames) {
      const schema = namedSchemas[refName];
      if (!schema) continue;
      // Build the body with cycle-break: nested lazy with same refName emits z.lazy(() => refName)
      const body = schemaToZodBase(schema);
      consts.push(`const ${refName}Schema: z.ZodTypeAny = z.lazy(() => ${body});`);
    }

    return consts.join("\n") + "\n\n";
  }

  private buildZodConst(op: NormalizedOperation): string {
    const props: string[] = [];

    for (const param of op.parameters) {
      const zodStr = schemaToZodStr(param.schema, param.required);
      const desc = param.description ? `.describe(${JSON.stringify(param.description)})` : "";
      props.push(`  ${sanitizeKey(param.name)}: ${zodStr}${desc}`);
    }

    if (op.requestBody) {
      const zodStr = schemaToZodStr(op.requestBody.schema, op.requestBody.required);
      props.push(`  body: ${zodStr}.describe("Request body")`);
    }

    const schemaName = `${op.toolName}Schema`;
    return `const ${schemaName} = z.object({\n${props.join(",\n")}\n});`;
  }

  private buildToolDef(op: NormalizedOperation): string {
    const schemaName = `${op.toolName}Schema`;
    return `{
      name: ${JSON.stringify(op.toolName)},
      description: ${JSON.stringify(op.summary)},
      inputSchema: {
        type: "object",
        properties: zodToJsonSchemaProperties(${schemaName}),
        required: getRequiredFields(${schemaName}),
      },
    }`;
  }

  private buildCase(op: NormalizedOperation, ctx: EmitterContext): string {
    const schemaName = `${op.toolName}Schema`;
    // Use bracket notation for all parameter access — safe for non-identifier names like "x-request-id"
    const queryArgs = op.parameters
      .filter(p => p.in === "query")
      .map(p => `${JSON.stringify(p.name)}: parsed[${JSON.stringify(p.name)}]`);

    const urlExpr = buildUrlExpr(op.path, op.parameters);
    const paramsExpr = queryArgs.length > 0
      ? `{ params: { ${queryArgs.join(", ")} } }`
      : "{}";

    const methodCall = `await client.${op.method}(${urlExpr}, ${
      op.method === "get" || op.method === "delete"
        ? paramsExpr
        : `${op.requestBody ? "parsed[\"body\"]" : "undefined"}, ${paramsExpr}`
    })`;

    return `case ${JSON.stringify(op.toolName)}: {
        const parsed = ${schemaName}.parse(args);
        void parsed; // suppress unused warning if no params
        const result = ${methodCall};
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
      }`;
  }

  private buildClientTs(ctx: EmitterContext, authEnvVar: string): string {
    const header = generatedFileHeader(ctx.serverName);

    if (ctx.authType === "oauth_client_credentials") {
      return this.buildOAuthClientTs(ctx, header);
    }

    const authHeader = buildAuthInjection(ctx.authType, authEnvVar);
    const authComment =
      ctx.authType !== "none"
        ? authEnvVarComment(
            ctx.authType,
            authEnvVar,
            ctx.authType === "api_key_query" ? "api_key" : "Authorization"
          ) + "\n"
        : "";

    return `${header}
import axios from "axios";

${authComment}
const client = axios.create({
  baseURL: ${JSON.stringify(ctx.baseUrl)},
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ${authHeader}
  },
});

export { client };
`;
  }

  private buildOAuthClientTs(ctx: EmitterContext, header: string): string {
    // SSRF guard on tokenEndpoint was applied at call site (write.ts) before reaching here.
    // If tokenEndpoint failed validation it arrives as empty string; use env var only.
    const tokenEndpointDefault = ctx.tokenEndpoint ?? "";

    return `${header}
import axios from "axios";

// OAuth 2.0 clientCredentials auto-token fetcher.
// Set OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, and optionally OAUTH_TOKEN_ENDPOINT.
// The token endpoint defaults to the value from the API spec.

const TOKEN_ENDPOINT = process.env.OAUTH_TOKEN_ENDPOINT ?? ${JSON.stringify(tokenEndpointDefault)};

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  let res: Awaited<ReturnType<typeof axios.post<{ access_token: string; expires_in: number }>>>;
  try {
    res = await axios.post<{ access_token: string; expires_in: number }>(
      TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.OAUTH_CLIENT_ID ?? "",
        client_secret: process.env.OAUTH_CLIENT_SECRET ?? "",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(\`OAuth token fetch failed (\${TOKEN_ENDPOINT}): \${msg}\`);
  }
  // Default to 1 hour when expires_in is missing, zero, or negative (RFC 6749 allows omission).
  const expiresIn = typeof res.data.expires_in === "number" && res.data.expires_in > 0
    ? res.data.expires_in
    : 3600;
  tokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return tokenCache.token;
}

export const client = axios.create({
  baseURL: ${JSON.stringify(ctx.baseUrl)},
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
});

client.interceptors.request.use(async (config) => {
  config.headers.Authorization = \`Bearer \${await getToken()}\`;
  return config;
});
`;
  }
}

// ─── Schema to Zod string ─────────────────────────────────────────────────────

export function schemaToZodStr(schema: NormalizedSchema, required = true): string {
  let base = schemaToZodBase(schema);
  if (isNullable(schema)) base += ".nullable()";
  if (!required) base += ".optional()";
  return base;
}

function isNullable(schema: NormalizedSchema): boolean {
  if ("nullable" in schema) return (schema as { nullable: boolean }).nullable;
  return false;
}

function schemaToZodBase(schema: NormalizedSchema): string {
  switch (schema.kind) {
    case "string":
      if (schema.enum && schema.enum.length > 0) {
        return `z.enum([${schema.enum.map(v => JSON.stringify(v)).join(", ")}])`;
      }
      if (schema.format === "date-time") return "z.string().datetime()";
      if (schema.format === "date") return "z.string().date()";
      if (schema.format === "email") return "z.string().email()";
      if (schema.format === "uri") return "z.string().url()";
      return "z.string()";

    case "number":
      return schema.integer ? "z.number().int()" : "z.number()";

    case "boolean":
      return "z.boolean()";

    case "array":
      return `z.array(${schemaToZodStr(schema.items)})`;

    case "object": {
      const entries = Object.entries(schema.properties);
      if (entries.length === 0) return "z.record(z.unknown())";
      const fields = entries
        .map(([k, v]) => `  ${sanitizeKey(k)}: ${schemaToZodStr(v.schema, v.required)}`)
        .join(",\n");
      return `z.object({\n${fields}\n})`;
    }

    case "union":
      if (schema.variants.length === 1) return schemaToZodStr(schema.variants[0]!);
      return `z.union([${schema.variants.map(v => schemaToZodStr(v)).join(", ")}])`;

    case "intersection":
      if (schema.parts.length === 1) return schemaToZodStr(schema.parts[0]!);
      return schema.parts
        .slice(1)
        .reduce(
          (acc, part) => `z.intersection(${acc}, ${schemaToZodStr(part)})`,
          schemaToZodStr(schema.parts[0]!)
        );

    case "lazy":
      // References a named circular schema — the const is hoisted at file top by the emitter.
      return `z.lazy(() => ${schema.refName}Schema)`;

    case "unknown":
      return "z.unknown()";
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function defaultEnvVar(authType: EmitterContext["authType"]): string {
  switch (authType) {
    case "bearer": return "BEARER_TOKEN";
    case "api_key_header": return "API_KEY_HEADER";
    case "api_key_query": return "API_KEY_QUERY";
    case "oauth_client_credentials": return "OAUTH_CLIENT_ID";
    default: return "";
  }
}

function buildAuthInjection(
  authType: EmitterContext["authType"],
  envVar: string
): string {
  switch (authType) {
    case "bearer":
      return `...(process.env.${envVar} ? { "Authorization": \`Bearer \${process.env.${envVar}}\` } : {})`;
    case "api_key_header":
      return `...(process.env.${envVar} ? { "X-API-Key": process.env.${envVar} } : {})`;
    case "api_key_query":
      return ""; // query params injected per-request, not in headers
    case "oauth_client_credentials":
      return ""; // token injected via axios interceptor in buildClientTs
    default:
      return "";
  }
}

function buildUrlExpr(urlPath: string, params: NormalizedOperation["parameters"]): string {
  const pathParams = params.filter(p => p.in === "path");
  if (pathParams.length === 0) return JSON.stringify(urlPath);
  // Always use template literal — safe for any param name including non-identifiers
  const tmpl = urlPath.replace(
    /\{([^}]+)\}/g,
    (_, paramName: string) => `\${parsed[${JSON.stringify(paramName)}]}`
  );
  return `\`${tmpl}\``;
}

function sanitizeKey(key: string): string {
  // Returns the key as a valid JS/TS property name.
  // For Zod object keys and property access: valid identifiers used as-is, others quoted.
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key;
  return JSON.stringify(key);
}

// DFS over a NormalizedSchema tree; collects all { kind:"lazy" } refNames.
// Used by buildLazyConsts to determine which named schemas need hoisted z.lazy() declarations.
function collectLazyRefs(schema: NormalizedSchema, out: Set<string>): void {
  switch (schema.kind) {
    case "lazy":
      out.add(schema.refName);
      break;
    case "array":
      collectLazyRefs(schema.items, out);
      break;
    case "object":
      for (const { schema: s } of Object.values(schema.properties)) {
        collectLazyRefs(s, out);
      }
      break;
    case "union":
      for (const v of schema.variants) collectLazyRefs(v, out);
      break;
    case "intersection":
      for (const p of schema.parts) collectLazyRefs(p, out);
      break;
    default:
      break;
  }
}

// Inlined into every generated server — converts Zod schemas to JSON Schema for MCP tool definitions.
const RUNTIME_HELPERS = `
function zodToJsonSchemaProperties(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    props[key] = zodTypeToJsonSchema(value as z.ZodTypeAny);
  }
  return props;
}

function zodTypeToJsonSchema(type: z.ZodTypeAny): Record<string, unknown> {
  if (type instanceof z.ZodString) return { type: "string" };
  if (type instanceof z.ZodNumber) return { type: "number" };
  if (type instanceof z.ZodBoolean) return { type: "boolean" };
  if (type instanceof z.ZodArray) return { type: "array" };
  if (type instanceof z.ZodObject) return { type: "object" };
  if (type instanceof z.ZodOptional) return zodTypeToJsonSchema(type.unwrap());
  if (type instanceof z.ZodNullable) return zodTypeToJsonSchema(type.unwrap());
  return { type: "string" };
}

function getRequiredFields(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    if (!(value instanceof z.ZodOptional)) required.push(key);
  }
  return required;
}`;
