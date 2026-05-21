import { z } from "zod";
import { SpecSourceSchema, parseSpec } from "./parse.js";
import { schemaToZodStr } from "../codegen/emitters/mcp.js";
import { toolSuccess, toolError } from "../types.js";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const GenerateSchemasInput = z.object({
  source: SpecSourceSchema,
  operation_ids: z.array(z.string()).optional(),
  include_optional_params: z.boolean().default(true),
});

// ─── Tool handler ─────────────────────────────────────────────────────────────

export async function handleGenerateSchemas(args: unknown) {
  try {
    const input = GenerateSchemasInput.parse(args);
    const parsed = await parseSpec(input.source);

    // Re-use cached IR from parseSpec — getCachedIR is keyed by specHash
    const { getCachedIR } = await import("../cache.js");
    const ir = getCachedIR(parsed.specHash);
    if (!ir) throw new Error("IR cache miss after parse — this is a bug");

    let operations = ir;
    if (input.operation_ids && input.operation_ids.length > 0) {
      operations = ir.filter(op =>
        input.operation_ids!.includes(op.operationId) ||
        input.operation_ids!.includes(op.toolName)
      );
      if (operations.length === 0) {
        throw new Error(
          `No operations matched the provided filter. Available: ${ir.map(o => o.toolName).join(", ")}`
        );
      }
    }

    // Operation count guard
    if (operations.length > 100) {
      throw new Error(
        `Spec has ${operations.length} operations (limit: 100 for schema generation). ` +
          `Use operation_ids to filter. Available tags: ${Object.keys(parsed.operationsByTag).join(", ")}`
      );
    }
    if (operations.length > 50) {
      parsed.warnings.push(
        `Large schema set (${operations.length} operations) — consider filtering by operation_ids`
      );
    }

    const schemas = operations.map(op => {
      const props: string[] = [];

      for (const param of op.parameters) {
        if (!input.include_optional_params && !param.required) continue;
        props.push(`  ${param.name}: ${schemaToZodStr(param.schema, param.required)}`);
      }
      if (op.requestBody) {
        props.push(`  body: ${schemaToZodStr(op.requestBody.schema, op.requestBody.required)}`);
      }

      const inputSchemaZod =
        props.length > 0
          ? `z.object({\n${props.join(",\n")}\n})`
          : "z.object({})";

      return {
        operation_id: op.operationId,
        tool_name: op.toolName,
        input_schema_zod: inputSchemaZod,
        description: op.summary,
        warnings: op.warnings,
      };
    });

    return toolSuccess({ schemas, parse_warnings: parsed.warnings });
  } catch (error) {
    return toolError(formatError(error));
  }
}

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid input: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}
