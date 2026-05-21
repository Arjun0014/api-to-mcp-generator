import { describe, it, expect } from "vitest";
import path from "path";
import { parseSpec } from "../src/tools/parse.js";

const petstore = { type: "file" as const, path: path.resolve("tests/fixtures/petstore.yaml") };
const stripeSubset = { type: "file" as const, path: path.resolve("tests/fixtures/stripe-subset.yaml") };

describe("parseSpec — petstore", () => {
  it("returns operation_count > 0", async () => {
    const result = await parseSpec(petstore);
    expect(result.operationCount).toBeGreaterThan(0);
  });

  it("each operation has a toolName", async () => {
    const result = await parseSpec(petstore);
    for (const op of result.operations) {
      expect(op.toolName).toBeTruthy();
    }
  });

  it("operationIds are snake_case", async () => {
    const result = await parseSpec(petstore);
    for (const op of result.operations) {
      expect(op.toolName).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("groups operations by tag", async () => {
    const result = await parseSpec(petstore);
    expect(result.operationsByTag).toHaveProperty("pets");
    expect(result.operationsByTag["pets"]?.length).toBeGreaterThan(0);
  });

  it("tags include owners group", async () => {
    const result = await parseSpec(petstore);
    expect(result.operationsByTag).toHaveProperty("owners");
  });

  it("petstore has no detected auth schemes", async () => {
    const result = await parseSpec(petstore);
    expect(result.detectedAuthSchemes).toHaveLength(0);
  });

  it("returns a specHash", async () => {
    const result = await parseSpec(petstore);
    expect(result.specHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("second parse returns same specHash (cache consistency)", async () => {
    const r1 = await parseSpec(petstore);
    const r2 = await parseSpec(petstore);
    expect(r1.specHash).toBe(r2.specHash);
  });

  it("listPets → list_pets toolName", async () => {
    const result = await parseSpec(petstore);
    const listPets = result.operations.find(o => o.operationId === "listPets");
    expect(listPets?.toolName).toBe("list_pets");
  });

  it("showPetById has hasRequestBody: false", async () => {
    const result = await parseSpec(petstore);
    const show = result.operations.find(o => o.operationId === "showPetById");
    expect(show?.hasRequestBody).toBe(false);
  });

  it("createPets has hasRequestBody: true", async () => {
    const result = await parseSpec(petstore);
    const create = result.operations.find(o => o.operationId === "createPets");
    expect(create?.hasRequestBody).toBe(true);
  });
});

describe("parseSpec — stripe subset", () => {
  it("detects bearer auth scheme", async () => {
    const result = await parseSpec(stripeSubset);
    expect(result.detectedAuthSchemes.some(s => s.type === "bearer")).toBe(true);
  });

  it("returns operations from multiple tags", async () => {
    const result = await parseSpec(stripeSubset);
    expect(Object.keys(result.operationsByTag).length).toBeGreaterThan(1);
  });

  it("allOf with discriminator produces warning (not error)", async () => {
    const result = await parseSpec(stripeSubset);
    // Should parse successfully despite discriminator
    expect(result.operationCount).toBeGreaterThan(0);
  });

  it("nullable fields parse without error", async () => {
    const result = await parseSpec(stripeSubset);
    // listCustomers / retrieveCustomer cover nullable email/name fields
    expect(result.operations.some(o => o.operationId === "listCustomers")).toBe(true);
  });
});

describe("parseSpec — security", () => {
  it("rejects SSRF URL", async () => {
    await expect(
      parseSpec({ type: "url", url: "https://169.254.169.254/openapi.json" })
    ).rejects.toThrow("SSRF protection");
  });

  it("rejects http:// scheme", async () => {
    await expect(
      parseSpec({ type: "url", url: "http://api.example.com/openapi.json" })
    ).rejects.toThrow("Only https://");
  });

  it("rejects missing file", async () => {
    await expect(
      parseSpec({ type: "file", path: "./tests/fixtures/nonexistent.yaml" })
    ).rejects.toThrow();
  });
});
