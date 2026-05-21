import { describe, it, expect } from "vitest";
import { validateSourceUrl, validateOutputDir, validateFilePath, checkDereferencedSize } from "../src/security/guards.js";

describe("validateSourceUrl", () => {
  it("allows https:// URL", () => {
    expect(() => validateSourceUrl("https://api.example.com/openapi.json")).not.toThrow();
  });

  it("blocks http:// scheme", () => {
    expect(() => validateSourceUrl("http://api.example.com/openapi.json")).toThrow(
      "Only https://"
    );
  });

  it("blocks IPv4 SSRF: 169.254.169.254 (AWS metadata)", () => {
    expect(() => validateSourceUrl("https://169.254.169.254/latest/meta-data")).toThrow(
      "SSRF protection"
    );
  });

  it("blocks IPv4 SSRF: 10.0.0.1 (RFC1918)", () => {
    expect(() => validateSourceUrl("https://10.0.0.1/api")).toThrow("SSRF protection");
  });

  it("blocks IPv4 SSRF: 192.168.1.1 (RFC1918)", () => {
    expect(() => validateSourceUrl("https://192.168.1.1/api")).toThrow("SSRF protection");
  });

  it("blocks IPv4 SSRF: 172.16.0.1 (RFC1918)", () => {
    expect(() => validateSourceUrl("https://172.16.0.1/api")).toThrow("SSRF protection");
  });

  it("blocks IPv4 SSRF: 172.31.0.1 (RFC1918 upper bound)", () => {
    expect(() => validateSourceUrl("https://172.31.0.1/api")).toThrow("SSRF protection");
  });

  it("allows 172.32.0.1 (outside RFC1918 range)", () => {
    expect(() => validateSourceUrl("https://172.32.0.1/api")).not.toThrow();
  });

  it("blocks localhost", () => {
    expect(() => validateSourceUrl("https://localhost/api")).toThrow("SSRF protection");
  });

  it("blocks 127.0.0.1", () => {
    expect(() => validateSourceUrl("https://127.0.0.1/api")).toThrow("SSRF protection");
  });

  it("blocks IPv6 loopback [::1]", () => {
    expect(() => validateSourceUrl("https://[::1]/api")).toThrow("SSRF protection");
  });

  it("blocks IPv6 link-local [fe80::1]", () => {
    expect(() => validateSourceUrl("https://[fe80::1]/api")).toThrow("SSRF protection");
  });

  it("blocks IPv6-mapped AWS metadata [::ffff:169.254.169.254]", () => {
    expect(() => validateSourceUrl("https://[::ffff:169.254.169.254]/api")).toThrow(
      "SSRF protection"
    );
  });

  it("throws on invalid URL", () => {
    expect(() => validateSourceUrl("not-a-url")).toThrow("Invalid URL");
  });
});

describe("validateOutputDir", () => {
  it("allows path inside temp/user directory", () => {
    expect(() => validateOutputDir(process.env["HOME"] + "/test-output")).not.toThrow();
  });

  it("blocks /etc on Unix", () => {
    if (process.platform === "win32") return;
    expect(() => validateOutputDir("/etc/output")).toThrow("Unsafe output directory");
  });

  it("blocks /usr/bin on Unix", () => {
    if (process.platform === "win32") return;
    expect(() => validateOutputDir("/usr/bin/output")).toThrow("Unsafe output directory");
  });

  it("blocks C:\\Windows on win32", () => {
    if (process.platform !== "win32") return;
    expect(() => validateOutputDir("C:\\Windows\\output")).toThrow("Unsafe output directory");
  });

  it("blocks C:\\Program Files on win32", () => {
    if (process.platform !== "win32") return;
    expect(() => validateOutputDir("C:\\Program Files\\output")).toThrow(
      "Unsafe output directory"
    );
  });
});

describe("validateFilePath", () => {
  it("allows relative path to a spec file", () => {
    expect(() => validateFilePath("./tests/fixtures/petstore.yaml")).not.toThrow();
  });

  it("blocks /etc/passwd on Unix", () => {
    if (process.platform === "win32") return;
    expect(() => validateFilePath("/etc/passwd")).toThrow("path traversal protection");
  });
});

describe("checkDereferencedSize", () => {
  it("passes a normal small doc", () => {
    expect(() => checkDereferencedSize({ info: { title: "T", version: "1" }, paths: {} })).not.toThrow();
  });

  it("passes a doc with circular object references (does NOT throw)", () => {
    // This is the Stripe scenario: swagger-parser dereferences a spec with circular
    // $refs and produces a JS object graph with cycles. V2 normalizer handles these
    // via WeakSet — checkDereferencedSize must not reject them.
    const a: Record<string, unknown> = { name: "A" };
    const b: Record<string, unknown> = { name: "B", ref: a };
    a["ref"] = b; // circular: a → b → a
    expect(() => checkDereferencedSize({ paths: {}, components: { schemas: { A: a } } })).not.toThrow();
  });

  it("throws on oversized doc", () => {
    // Simulate a doc that exceeds 25MB when serialised
    const big = { data: "x".repeat(26 * 1024 * 1024) };
    expect(() => checkDereferencedSize(big)).toThrow("too large");
  });
});
