import type { NormalizedOperation, NormalizedSchema } from "../../ir/types.js";
import type { GeneratedServer } from "../../types.js";
import { MCPEmitter } from "./mcp.js";

export interface EmitterContext {
  baseUrl: string;
  serverName: string;
  authType: "none" | "bearer" | "api_key_header" | "api_key_query" | "oauth_client_credentials";
  authEnvVar?: string; // defaults to BEARER_TOKEN / API_KEY_HEADER / API_KEY_QUERY
  tokenEndpoint?: string; // OAuth clientCredentials: tokenUrl from spec (SSRF-validated at codegen time)
  namedSchemas?: Record<string, NormalizedSchema>; // components.schemas — for z.lazy() hoisting
}

type SupportedProtocol = "mcp";

export function emit(
  ir: NormalizedOperation[],
  protocol: SupportedProtocol,
  ctx: EmitterContext
): GeneratedServer {
  switch (protocol) {
    case "mcp":
      return new MCPEmitter().emit(ir, ctx);
    default: {
      const _exhaustive: never = protocol;
      throw new Error(`Unknown emit protocol: ${String(_exhaustive)}`);
    }
  }
}
