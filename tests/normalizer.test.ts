import { describe, it, expect } from "vitest";
import { normalizeSchema, normalizeSpec } from "../src/codegen/normalizer.js";
import { makeNormCtx } from "../src/ir/types.js";
import type { OpenAPIV3 } from "openapi-types";

function ctx() {
  return makeNormCtx();
}

describe("normalizeSchema — string variants", () => {
  it("plain string → kind:string", () => {
    const result = normalizeSchema({ type: "string" }, ctx());
    expect(result).toEqual({ kind: "string", nullable: false });
  });

  it("string + enum → kind:string with enum", () => {
    const result = normalizeSchema({ type: "string", enum: ["foo", "bar"] }, ctx());
    expect(result).toEqual({ kind: "string", enum: ["foo", "bar"], nullable: false });
  });

  it("string + format:date-time → format preserved", () => {
    const result = normalizeSchema({ type: "string", format: "date-time" }, ctx());
    expect(result).toMatchObject({ kind: "string", format: "date-time" });
  });

  it("nullable:true → nullable flag set", () => {
    const result = normalizeSchema({ type: "string", nullable: true }, ctx());
    expect(result).toMatchObject({ kind: "string", nullable: true });
  });
});

describe("normalizeSchema — number variants", () => {
  it("type:integer → kind:number integer:true", () => {
    const result = normalizeSchema({ type: "integer" }, ctx());
    expect(result).toEqual({ kind: "number", integer: true, nullable: false });
  });

  it("type:number → kind:number integer:false", () => {
    const result = normalizeSchema({ type: "number" }, ctx());
    expect(result).toEqual({ kind: "number", integer: false, nullable: false });
  });
});

describe("normalizeSchema — boolean", () => {
  it("boolean → kind:boolean", () => {
    const result = normalizeSchema({ type: "boolean" }, ctx());
    expect(result).toEqual({ kind: "boolean", nullable: false });
  });
});

describe("normalizeSchema — array", () => {
  it("array + items:string → kind:array with string items", () => {
    const result = normalizeSchema({ type: "array", items: { type: "string" } } as OpenAPIV3.ArraySchemaObject, ctx());
    expect(result).toMatchObject({ kind: "array", items: { kind: "string" } });
  });

  it("array without items → kind:array with unknown + warning", () => {
    const result = normalizeSchema({ type: "array" } as OpenAPIV3.ArraySchemaObject, ctx());
    expect(result).toMatchObject({ kind: "array" });
    if (result.kind === "array") {
      expect(result.items.kind).toBe("unknown");
    }
  });
});

describe("normalizeSchema — object", () => {
  it("object + properties → kind:object with fields", () => {
    const result = normalizeSchema(
      {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
        required: ["name"],
      },
      ctx()
    );
    expect(result.kind).toBe("object");
    if (result.kind === "object") {
      expect(result.properties["name"]?.required).toBe(true);
      expect(result.properties["age"]?.required).toBe(false);
    }
  });

  it("object without properties → kind:object with empty properties", () => {
    const result = normalizeSchema({ type: "object" }, ctx());
    expect(result.kind).toBe("object");
    if (result.kind === "object") {
      expect(result.properties).toEqual({});
    }
  });
});

describe("normalizeSchema — composition", () => {
  it("oneOf [string, number] → kind:union with 2 variants", () => {
    const result = normalizeSchema(
      { oneOf: [{ type: "string" }, { type: "number" }] },
      ctx()
    );
    expect(result.kind).toBe("union");
    if (result.kind === "union") expect(result.variants).toHaveLength(2);
  });

  it("anyOf [a, b, c] → kind:union with 3 variants", () => {
    const result = normalizeSchema(
      { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
      ctx()
    );
    expect(result.kind).toBe("union");
    if (result.kind === "union") expect(result.variants).toHaveLength(3);
  });

  it("allOf without discriminator → kind:intersection", () => {
    const result = normalizeSchema(
      {
        allOf: [
          { type: "object", properties: { id: { type: "string" } } },
          { type: "object", properties: { name: { type: "string" } } },
        ],
      },
      ctx()
    );
    expect(result.kind).toBe("intersection");
  });

  it("allOf with discriminator → kind:unknown + warning", () => {
    const result = normalizeSchema(
      {
        allOf: [{ type: "object" }],
        discriminator: { propertyName: "type" },
      },
      ctx()
    );
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.warning).toContain("discriminator");
    }
  });
});

describe("normalizeSchema — guards", () => {
  it("maxDepth exceeded → kind:unknown + warning", () => {
    const deepCtx = makeNormCtx();
    deepCtx.depth = 21;
    const result = normalizeSchema({ type: "string" }, deepCtx);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.warning).toContain("deeply nested");
    }
  });

  it("circular reference → kind:unknown + warning", () => {
    const c = ctx();
    const schema: OpenAPIV3.SchemaObject = { type: "object" };
    c.visited.add(schema as object); // WeakSet uses .add()
    const result = normalizeSchema(schema, c);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.warning).toContain("circular");
    }
  });
});

describe("normalizeSpec — operationId handling", () => {
  const minimalDoc = (paths: OpenAPIV3.Document["paths"]): OpenAPIV3.Document => ({
    openapi: "3.0.0",
    info: { title: "Test", version: "1.0.0" },
    paths,
  });

  it("uses operationId as toolName (camelCase → snake_case)", () => {
    const { operations } = normalizeSpec(
      minimalDoc({
        "/pets": {
          get: {
            operationId: "listPets",
            summary: "List pets",
            responses: { "200": { description: "ok" } },
          },
        },
      })
    );
    expect(operations[0]?.toolName).toBe("list_pets");
  });

  it("generates toolName from method+path when operationId missing", () => {
    const { operations } = normalizeSpec(
      minimalDoc({
        "/users/{id}": {
          get: {
            summary: "Get user",
            responses: { "200": { description: "ok" } },
          },
        },
      })
    );
    expect(operations[0]?.toolName).toMatch(/get_users_by_id/);
  });

  it("deduplicates colliding toolNames with _2 suffix", () => {
    const { operations } = normalizeSpec(
      minimalDoc({
        "/pets": {
          get: {
            operationId: "list_pets",
            summary: "List pets A",
            responses: { "200": { description: "ok" } },
          },
          post: {
            operationId: "list_pets",
            summary: "List pets B",
            responses: { "200": { description: "ok" } },
          },
        },
      })
    );
    const names = operations.map(o => o.toolName);
    expect(new Set(names).size).toBe(names.length); // all unique
    expect(names).toContain("list_pets");
    expect(names).toContain("list_pets_2");
    expect(operations.find(o => o.toolName === "list_pets_2")?.warnings[0]).toMatch(
      /deduplicated/
    );
  });
});
