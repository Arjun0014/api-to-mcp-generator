import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { handleParseSpec } from "./tools/parse.js";
import { handleGenerateSchemas } from "./tools/schemas.js";
import { handleWriteServer } from "./tools/write.js";
import { handleGenerateConfig } from "./tools/config.js";
import { handleRunValidation } from "./tools/validate.js";
import { handleGenerateReadme } from "./tools/readme.js";

const server = new Server(
  { name: "api-to-mcp-generator", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "parse_openapi_spec",
      description:
        "Fetch and validate an OpenAPI 3.x spec from a URL or local file path. Returns operations grouped by tag, detected auth schemes, and a spec hash for caching.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            oneOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["url"] },
                  url: { type: "string", description: "HTTPS URL to the OpenAPI spec" },
                },
                required: ["type", "url"],
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["file"] },
                  path: { type: "string", description: "Absolute or relative path to OpenAPI spec file" },
                },
                required: ["type", "path"],
              },
            ],
            description: "Source of the OpenAPI spec — URL or local file path",
          },
          auth_header: {
            type: "string",
            description: "Optional Bearer token if the spec URL requires authentication",
          },
        },
        required: ["source"],
      },
    },
    {
      name: "generate_tool_schemas",
      description:
        "Preview and inspect Zod input schemas for each API operation without generating a full server. Use this before write_mcp_server to verify schema normalization, or to integrate schemas into an existing MCP server.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            oneOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["url"] },
                  url: { type: "string" },
                },
                required: ["type", "url"],
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["file"] },
                  path: { type: "string" },
                },
                required: ["type", "path"],
              },
            ],
          },
          operation_ids: {
            type: "array",
            items: { type: "string" },
            description: "Filter to specific operationIds or toolNames. If omitted, generates for all operations (max 100).",
          },
          include_optional_params: {
            type: "boolean",
            description: "Include optional parameters in generated schemas (default: true)",
          },
        },
        required: ["source"],
      },
    },
    {
      name: "write_mcp_server",
      description:
        "Generate and write a complete TypeScript MCP server from an OpenAPI spec. Use dry_run:true to preview files without writing, force:true to overwrite existing files.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            oneOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["url"] },
                  url: { type: "string" },
                },
                required: ["type", "url"],
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["file"] },
                  path: { type: "string" },
                },
                required: ["type", "path"],
              },
            ],
          },
          output_dir: { type: "string", description: "Absolute path to write the generated server" },
          server_name: { type: "string", description: "Name for the generated MCP server" },
          base_url: { type: "string", description: "Override the base URL from the spec" },
          auth_type: {
            type: "string",
            enum: ["none", "bearer", "api_key_header", "api_key_query", "oauth_client_credentials"],
            description: "Auth type — auto-detected from spec if omitted",
          },
          auth_env_var: {
            type: "string",
            description: "Env var name for auth token (e.g. BEARER_TOKEN)",
          },
          tag: {
            type: "string",
            description: "Generate only operations from this tag group (mutually exclusive with operation_ids)",
          },
          operation_ids: {
            type: "array",
            items: { type: "string" },
            description: "Generate only these operations (by operationId or toolName)",
          },
          dry_run: {
            type: "boolean",
            description: "Return file contents without writing to disk",
          },
          force: {
            type: "boolean",
            description: "Overwrite existing files (does not bypass security guards)",
          },
        },
        required: ["source", "output_dir", "server_name"],
      },
    },
    {
      name: "generate_mcp_config",
      description:
        "Generate a .mcp.json config file for Claude Desktop or Claude Code to use the generated server.",
      inputSchema: {
        type: "object",
        properties: {
          output_dir: { type: "string", description: "Directory containing the generated server" },
          server_name: { type: "string" },
          env_vars: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Additional environment variables (auth env var auto-populated from manifest if present)",
          },
        },
        required: ["output_dir", "server_name"],
      },
    },
    {
      name: "run_validation",
      description:
        "Validate a generated MCP server by installing dependencies, compiling TypeScript, starting the server, and probing it with MCP initialize + tools/list. Reports per-phase results with timing.",
      inputSchema: {
        type: "object",
        properties: {
          output_dir: { type: "string", description: "Directory containing the generated server" },
          timeout_ms: {
            type: "number",
            description: "Total timeout in milliseconds (default: 120000 — npm install can take 60-90s on first run)",
          },
        },
        required: ["output_dir"],
      },
    },
    {
      name: "generate_readme",
      description:
        "Write a README.md for the generated server. Reads from the generation manifest if present (describes the actual generated tools), otherwise re-parses the source spec.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            oneOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["url"] },
                  url: { type: "string" },
                },
                required: ["type", "url"],
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["file"] },
                  path: { type: "string" },
                },
                required: ["type", "path"],
              },
            ],
            description: "Source spec — optional if output_dir has a manifest",
          },
          output_dir: { type: "string" },
          server_name: { type: "string" },
        },
        required: ["output_dir", "server_name"],
      },
    },
  ],
}));

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "parse_openapi_spec":
      return handleParseSpec(args);
    case "generate_tool_schemas":
      return handleGenerateSchemas(args);
    case "write_mcp_server":
      return handleWriteServer(args);
    case "generate_mcp_config":
      return handleGenerateConfig(args);
    case "run_validation":
      return handleRunValidation(args);
    case "generate_readme":
      return handleGenerateReadme(args);
    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

void (async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
