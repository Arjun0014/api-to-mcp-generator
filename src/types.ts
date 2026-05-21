import type { NormalizedOperation, NormalizedAuth } from "./ir/types.js";

// ─── Spec source ──────────────────────────────────────────────────────────────
// Discriminated union — no string inference, no file:// URLs.
// type: "url"  → SSRF validation + https:// only
// type: "file" → path traversal validation

export type SpecSource =
  | { type: "url"; url: string }
  | { type: "file"; path: string };

// ─── Parse result ─────────────────────────────────────────────────────────────

export interface OperationSummary {
  operationId: string;
  toolName: string;
  method: string;
  path: string;
  summary: string;
  hasRequestBody: boolean;
  responseCodes: string[];
}

export interface DetectedAuthScheme {
  name: string; // securityScheme key from spec
  type: "bearer" | "api_key_header" | "api_key_query";
  envVar: string;
  headerName?: string;
  queryParam?: string;
}

export interface ParseResult {
  title: string;
  version: string;
  baseUrl: string;
  operationCount: number;
  operations: OperationSummary[];
  operationsByTag: Record<string, OperationSummary[]>;
  detectedAuthSchemes: DetectedAuthScheme[];
  specHash: string;
  warnings: string[];
}

// ─── Generated server ─────────────────────────────────────────────────────────

export interface GeneratedServer {
  files: Record<string, string>; // relative path → file contents
  warnings: string[];
}

// ─── Generation manifest ──────────────────────────────────────────────────────

export interface GenerationManifest {
  generatorVersion: string;
  irVersion: string;
  generatedAt: string; // ISO 8601
  specSource: SpecSource;
  specHash: string; // SHA-256 of raw spec bytes
  selectedOperations: string[]; // toolNames that were generated
  generatedTools: string[]; // same as selectedOperations (alias for clarity)
  options: {
    serverName: string;
    baseUrl: string;
    authType: NormalizedAuth["type"];
    authEnvVar?: string;
  };
}

// ─── Warning collection ───────────────────────────────────────────────────────

export class WarningCollection {
  private warnings: string[] = [];

  add(msg: string): void {
    this.warnings.push(msg);
  }

  toArray(): string[] {
    return [...this.warnings];
  }

  hasWarnings(): boolean {
    return this.warnings.length > 0;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationCheck {
  name: "npm_install" | "typescript_compile" | "server_starts" | "tools_list";
  passed: boolean;
  skipped?: boolean;
  elapsedMs: number;
  output?: string;
  error?: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  errors: string[];
  warnings: string[];
}

// ─── MCP tool response helpers ────────────────────────────────────────────────

export function toolSuccess(result: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function toolError(message: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}
