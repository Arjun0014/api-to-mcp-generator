export type NormalizedSchema =
  | { kind: "string"; enum?: string[]; format?: string; nullable: boolean }
  | { kind: "number"; integer: boolean; nullable: boolean }
  | { kind: "boolean"; nullable: boolean }
  | { kind: "array"; items: NormalizedSchema; nullable: boolean }
  | {
      kind: "object";
      properties: Record<string, { schema: NormalizedSchema; required: boolean }>;
      nullable: boolean;
    }
  | { kind: "union"; variants: NormalizedSchema[]; nullable: boolean } // oneOf / anyOf
  | { kind: "intersection"; parts: NormalizedSchema[] } // allOf
  | { kind: "unknown"; warning: string }; // unnormalizable

export interface NormalizedAuth {
  type: "none" | "bearer" | "api_key_header" | "api_key_query";
  envVar?: string; // "BEARER_TOKEN" | "API_KEY_HEADER" | "API_KEY_QUERY"
  headerName?: string; // "Authorization" | "X-API-Key"
  queryParam?: string;
}

export interface NormalizedParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required: boolean;
  schema: NormalizedSchema;
  description?: string;
}

export interface NormalizedRequestBody {
  required: boolean;
  schema: NormalizedSchema;
  contentType: string;
}

export interface NormalizedResponse {
  statusCode: string;
  schema?: NormalizedSchema;
  description?: string;
}

export interface NormalizedOperation {
  toolName: string; // snake_case, derived from operationId or method+path
  operationId: string; // original, may be generated
  method: "get" | "post" | "put" | "delete" | "patch";
  path: string;
  summary: string;
  description?: string;
  parameters: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses: NormalizedResponse[];
  auth: NormalizedAuth;
  warnings: string[];
}

// Context passed through normalizer recursion
export interface NormCtx {
  visited: WeakSet<object>; // ancestor-chain tracker — add before recursing, delete after
  depth: number;
  seenToolNames: Set<string>;
}

export function makeNormCtx(): NormCtx {
  return { visited: new WeakSet(), depth: 0, seenToolNames: new Set() };
}
