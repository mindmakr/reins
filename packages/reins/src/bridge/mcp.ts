import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, TOOLS, type ToolContext } from './tools.js';

export const VERSION = '0.2.0';

/** Serves the reins tools over MCP on stdio. stdout belongs to MCP; logs go to stderr. */
export async function startMcp(ctx: ToolContext): Promise<Server> {
  ctx.snaps ??= [];
  const server = new Server({ name: 'reins', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as any }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await callTool(ctx, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: String(err.message ?? err) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
