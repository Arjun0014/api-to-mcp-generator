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

export class MCPEmitter {
  emit(ir: NormalizedOperation[], ctx: EmitterContext): GeneratedServer {
    const warnings: string[] = [];

    // Collect operation-level warnings
    for (const op of ir) {
      warnings.push(...op.warnings);
    }

    const authEnvVar = ctx.authEnvVar ?? defaultEnvVar(ctx.authType);

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

${zodConsts}

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
    const pathArgs = op.parameters
      .filter(p => p.in === "path")
      .map(p => `"${p.name}": parsed.${sanitizeKey(p.name)}`);
    const queryArgs = op.parameters
      .filter(p => p.in === "query")
      .map(p => `"${p.name}": parsed.${sanitizeKey(p.name)}`);

    const urlExpr = buildUrlExpr(op.path, op.parameters);
    const paramsExpr = queryArgs.length > 0
      ? `{ params: { ${queryArgs.join(", ")} } }`
      : "{}";
    const dataExpr = op.requestBody ? ", parsed.body" : "";

    const methodCall = `await client.${op.method}(${urlExpr}, ${
      op.method === "get" || op.method === "delete"
        ? paramsExpr
        : `${op.requestBody ? "parsed.body" : "undefined"}, ${paramsExpr}`
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

    case "unknown":
      return "z.unknown()";
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function defaultEnvVar(authType: "none" | "bearer" | "api_key_header" | "api_key_query"): string {
  switch (authType) {
    case "bearer": return "BEARER_TOKEN";
    case "api_key_header": return "API_KEY_HEADER";
    case "api_key_query": return "API_KEY_QUERY";
    default: return "";
  }
}

function buildAuthInjection(
  authType: "none" | "bearer" | "api_key_header" | "api_key_query",
  envVar: string
): string {
  switch (authType) {
    case "bearer":
      return `...(process.env.${envVar} ? { "Authorization": \`Bearer \${process.env.${envVar}}\` } : {})`;
    case "api_key_header":
      return `...(process.env.${envVar} ? { "X-API-Key": process.env.${envVar} } : {})`;
    case "api_key_query":
      return ""; // query params injected per-request, not in headers
    default:
      return "";
  }
}

function buildUrlExpr(path: string, params: NormalizedOperation["parameters"]): string {
  const pathParams = params.filter(p => p.in === "path");
  if (pathParams.length === 0) return JSON.stringify(path);

  let expr = JSON.stringify(path);
  for (const p of pathParams) {
    expr = expr.replace(`{${p.name}}`, `" + parsed.${sanitizeKey(p.name)} + "`);
  }
  // Clean up concatenation artifacts
  expr = expr.replace(/^"" \+ /, "").replace(/ \+ ""$/, "");
  if (!expr.startsWith('"') && !expr.startsWith("'")) return expr;
  return "`" + path.replace(/\{(\w+)\}/g, (_, k) => `\${parsed.${sanitizeKey(k)}}`) + "`";
}

function sanitizeKey(key: string): string {
  // If key is a valid JS identifier, use as-is; otherwise quote it
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) return key;
  return JSON.stringify(key);
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
