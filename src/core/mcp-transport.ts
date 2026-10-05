/**
 * Spawns and talks to an upstream MCP server over stdio (SPEC 3.4).
 *
 * Uses the official MCP SDK client so we inherit its framing, capabilities
 * handshake and error surface instead of hand-rolling JSON-RPC.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AdapterError, type Logger } from '../core/types.js';
import { unwrapToolContent, type McpToolResult } from './mcp-client.js';

export interface McpCallOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  toolName: string;
  toolArgs: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
  logger: Logger;
  sourceId: string;
}

export interface McpCallOutcome extends McpToolResult {
  elapsedMs: number;
}

/**
 * Runs exactly one tool call against a freshly spawned upstream server and then
 * closes it. Upstreams here are stateless per call from our point of view, and
 * a short-lived child guarantees a hung upstream cannot leak into later calls.
 */
export async function callUpstreamMcp(options: McpCallOptions): Promise<McpCallOutcome> {
  const started = Date.now();
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') childEnv[key] = value;
  }
  Object.assign(childEnv, options.env ?? {});

  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args ?? [],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: childEnv,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'unified-trial-mcp', version: '0.1.0' }, { capabilities: {} });

  const close = async (): Promise<void> => {
    try {
      await client.close();
    } catch {
      // A dead child is not an error worth surfacing.
    }
  };

  const onAbort = (): void => {
    void close();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await client.connect(transport);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AdapterError('TIMEOUT', 'UPSTREAM_TOOL_TIMEOUT', `上游工具 ${options.toolName} 在 ${options.timeoutMs}ms 内未返回。`, {
          fixHint: '稍后重试，或运行 doctor 检查该上游服务的运行时。',
        }));
      }, options.timeoutMs);
    });

    const call = client.callTool({ name: options.toolName, arguments: options.toolArgs });

    let raw: unknown;
    try {
      raw = await Promise.race([call, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const unwrapped = unwrapToolContent(raw, options.toolName);
    return { ...unwrapped, elapsedMs: Date.now() - started };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    const message = (error as Error)?.message ?? String(error);
    options.logger.debug('upstream_mcp_failed', {
      sourceId: options.sourceId,
      tool: options.toolName,
      message,
    });
    throw new AdapterError(
      'FAILED',
      'UPSTREAM_MCP_FAILED',
      `无法调用上游 MCP 工具 ${options.toolName}：${message}`,
      { fixHint: '确认该上游服务已安装并可通过 doctor 检查。' },
    );
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    await close();
  }
}
