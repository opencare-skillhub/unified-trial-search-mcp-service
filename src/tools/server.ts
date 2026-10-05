/**
 * MCP stdio server (SPEC 2.2, 4).
 *
 * One process, one stdio transport, seven tools. Everything below the tool
 * layer lives in the closed registry and config; callers cannot add sources,
 * point at URLs, or set timeouts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../core/types.js';
import { TOOL_SCHEMAS } from './schemas.js';
import { TOOL_HANDLERS, type ToolDeps } from './handlers.js';

export const SERVER_NAME = 'unified-trial-mcp';
export const SERVER_VERSION = '0.1.0';

export function createServer(deps: ToolDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SCHEMAS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const handler = TOOL_HANDLERS[name];

    if (!handler) {
      return {
        content: [{ type: 'text' as const, text: `未知工具：${name}` }],
        isError: true,
      };
    }

    const outcome = await handler(args, deps);
    const text = JSON.stringify(outcome.payload, null, 2);
    if (outcome.error) {
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: outcome.payload,
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: outcome.payload,
    };
  });

  return server;
}

export async function serveStdio(deps: ToolDeps, logger: Logger): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp_stdio_connected', { tools: TOOL_SCHEMAS.length });
}
