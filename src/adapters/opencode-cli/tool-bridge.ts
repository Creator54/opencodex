import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OcxParsedRequest } from "../../types";
import { buildCodeBuddyToolBridge, CODEBUDDY_MCP_TOOL_PREFIX } from "../codebuddy/tool-bridge";

/** Advertise client tools without executing them in the nested CLI. */
export function startOpenCodeToolBridge(parsed: OcxParsedRequest) {
  const catalog = buildCodeBuddyToolBridge(parsed);
  if (!catalog.tools.length) return undefined;
  const path = `/${crypto.randomUUID()}`;
  let resolveCall!: (call: { id: string; name: string; arguments: string }) => void;
  const captured = new Promise<{ id: string; name: string; arguments: string }>(resolve => { resolveCall = resolve; });
  // shortcut: serialize parallel intents; add multi-call capture when the CLI exposes an intent boundary.
  let called = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname !== path || request.headers.has("origin")) return new Response(null, { status: 403 });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = new Server({ name: "opencodex-capture", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.tools }));
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const name = catalog.emittedNameMap.get(`${CODEBUDDY_MCP_TOOL_PREFIX}${params.name}`);
        if (!name || called) throw new Error("Unknown tool or turn already captured");
        called = true;
        resolveCall({ id: `call_${crypto.randomUUID()}`, name, arguments: JSON.stringify(params.arguments ?? {}) });
        return { content: [{ type: "text", text: "Call captured. Execution belongs to the external client." }] };
      });
      try {
        await mcp.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await mcp.close();
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}${path}`, captured, requireToolCall: catalog.requireToolCall, close: () => server.stop(true) };
}
