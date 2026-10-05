/**
 * Minimal MCP stdio client used by the online adapters (SPEC 3.4, 6.2).
 *
 * The upstream channels (ICTRP, CTV, ChiCTR online) are themselves MCP servers.
 * This service therefore speaks MCP both ways: it *is* an MCP server for its
 * client, and it *is* an MCP client for these upstreams.
 *
 * Design constraints that matter:
 *  - Upstream envelope failures must never become zero records. If we cannot
 *    parse a reply we raise AdapterError('FAILED'), never a NO_RESULTS.
 *  - Tool names are taken from the closed registry, never from a caller.
 *  - The child process is killed on abort/timeout so a hung upstream cannot
 *    hold the global deadline open.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AdapterError } from '../core/types.js';

export interface McpToolResult {
  /** Unwrapped payload when the upstream returned JSON in a text block. */
  payload: unknown;
  raw: unknown;
  /** True when `payload` came from JSON.parse of a text content block. */
  parsed: boolean;
}

/** A machine-readable upstream error envelope, e.g. `{code, message, retryable}`. */
export interface UpstreamErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Recognises an upstream *error* envelope.
 *
 * Upstreams signal failure in two ways: a JSON error body, and/or the MCP
 * `isError` flag. Both must be treated as errors — an error body is never a
 * (possibly empty) result set.
 */
export function detectUpstreamError(raw: unknown, payload: unknown): UpstreamErrorEnvelope | undefined {
  const flagged = (raw as { isError?: unknown })?.isError === true;
  const body = payload as { code?: unknown; message?: unknown; retryable?: unknown; error?: unknown } | undefined;
  const code = typeof body?.code === 'string' ? body.code : undefined;
  const message = typeof body?.message === 'string' ? body.message : undefined;
  if (code && message) {
    return { code, message, retryable: body?.retryable === true };
  }
  if (flagged) {
    return {
      code: 'UNKNOWN_ERROR',
      message: typeof body?.error === 'string' ? body.error : `上游工具返回 isError，但未提供错误详情。`,
      retryable: body?.retryable === true,
    };
  }
  return undefined;
}

export interface UpstreamErrorClassification {
  state: 'NEEDS_SETUP' | 'CHALLENGE_REQUIRED' | 'RATE_LIMITED' | 'DENIED' | 'TIMEOUT' | 'FAILED';
  reasonCode: string;
  fixHint?: string;
  message: string;
}

/**
 * Maps a known upstream setup/runtime failure onto a precise state.
 *
 * This matters for honesty as much as for UX: a missing browser binary is a
 * *setup* problem the user can fix, not a mysterious failure, and it must never
 * be reported as "no results".
 */
export function classifyUpstreamError(envelope: UpstreamErrorEnvelope, sourceLabel: string): UpstreamErrorClassification {
  const text = `${envelope.code} ${envelope.message}`.toLowerCase();
  const firstLine = envelope.message.split('\n')[0]?.trim() ?? envelope.message;

  if (text.includes('playwright') || text.includes("executable doesn't exist") || text.includes('browser type')) {
    return {
      state: 'NEEDS_SETUP',
      reasonCode: 'UPSTREAM_BROWSER_MISSING',
      fixHint: '请在上游服务目录执行 npx playwright install 安装浏览器运行时；本服务不会自动下载浏览器。',
      message: `${sourceLabel} 上游缺少浏览器运行时：${firstLine}`,
    };
  }
  if (text.includes('captcha') || text.includes('challenge') || text.includes('验证码') || text.includes('人机验证')) {
    return {
      state: 'CHALLENGE_REQUIRED',
      reasonCode: 'UPSTREAM_CHALLENGE_REQUIRED',
      fixHint: '需要人工在浏览器中完成验证；本服务不会绕过验证码。',
      message: `${sourceLabel} 上游要求人机验证：${firstLine}`,
    };
  }
  if (text.includes('rate') || text.includes('429') || text.includes('cooldown') || text.includes('too many')) {
    return {
      state: 'RATE_LIMITED',
      reasonCode: 'UPSTREAM_RATE_LIMITED',
      fixHint: '上游处于限流或冷却期，请稍后重试。',
      message: `${sourceLabel} 上游限流：${firstLine}`,
    };
  }
  if (text.includes('timeout') || text.includes('etimedout')) {
    return {
      state: 'TIMEOUT',
      reasonCode: 'UPSTREAM_TOOL_TIMEOUT',
      message: `${sourceLabel} 上游超时：${firstLine}`,
    };
  }
  if (text.includes('econnrefused') || text.includes('enotfound') || text.includes('network')) {
    return {
      state: 'FAILED',
      reasonCode: 'UPSTREAM_NETWORK_ERROR',
      message: `${sourceLabel} 上游网络不可达：${firstLine}`,
    };
  }
  return {
    state: 'FAILED',
    reasonCode: `UPSTREAM_${envelope.code || 'ERROR'}`,
    message: `${sourceLabel} 上游返回错误：${firstLine}`,
  };
}

/** One text content block, e.g. `{ type: 'text', text: '...' }`. */
function textBlocks(raw: unknown): string[] {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text === 'string') out.push(text);
  }
  return out;
}

/**
 * Unwrap an MCP tool reply into a usable payload.
 *
 * Upstreams differ: some return a JSON string in one text block, some return
 * prose plus JSON, some return a structured object. `unwrapToolContent` never
 * guesses a count — an unrecognised envelope throws.
 */
export function unwrapToolContent(raw: unknown, toolName: string): McpToolResult {
  // Some upstreams already return structured content.
  const structured = (raw as { structuredContent?: unknown })?.structuredContent;
  if (structured && typeof structured === 'object') {
    const failure = detectUpstreamError(raw, structured);
    if (failure) throw upstreamError(failure, toolName);
    return { payload: structured, raw, parsed: true };
  }

  const blocks = textBlocks(raw);
  if (!blocks.length) {
    // Definitely a tool error or an unknown envelope: never zero results.
    if ((raw as { isError?: unknown })?.isError) {
      throw new AdapterError('FAILED', 'UPSTREAM_TOOL_ERROR', `上游工具 ${toolName} 返回 isError，且无可解析内容。`);
    }
    throw new AdapterError('FAILED', 'UPSTREAM_ENVELOPE_UNRECOGNISED', `上游工具 ${toolName} 的响应中没有可识别的文本内容。`);
  }

  for (const text of blocks) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      // Not JSON; try to find an embedded JSON object/array.
      candidate = extractEmbeddedJson(trimmed);
      if (candidate === undefined) continue;
    }
    // An error body is an error, even though it parsed cleanly.
    const failure = detectUpstreamError(raw, candidate);
    if (failure) throw upstreamError(failure, toolName);
    return { payload: candidate, raw, parsed: true };
  }

  throw new AdapterError(
    'FAILED',
    'UPSTREAM_ENVELOPE_UNRECOGNISED',
    `上游工具 ${toolName} 返回了文本但无法解析为结构化结果；本服务不会把无法解析的响应当作零结果。`,
  );
}

/** Turns a detected upstream error into a state-carrying AdapterError. */
export function upstreamError(envelope: UpstreamErrorEnvelope, toolName: string): AdapterError {
  const classification = classifyUpstreamError(envelope, toolName);
  return new AdapterError(classification.state, classification.reasonCode, classification.message, {
    ...(classification.fixHint ? { fixHint: classification.fixHint } : {}),
    details: { upstreamCode: envelope.code, upstreamRetryable: envelope.retryable, upstreamMessage: envelope.message },
  });
}

/** Finds the first balanced JSON object/array inside free text. */
function extractEmbeddedJson(text: string): unknown {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

export type McpTransport = 'stdio';

export interface UpstreamMcpOptions {
  /** Absolute path to the upstream server entry (validated by the caller). */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Resolves the Node entry file for an upstream MCP server, preferring a built
 * `dist` entry and falling back to the package's declared `bin`/`main`.
 *
 * Returns undefined when nothing usable exists, so callers can map that onto
 * NEEDS_SETUP instead of failing at spawn time with an opaque ENOENT.
 */
export async function resolveUpstreamEntry(root: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const absolute = path.resolve(root, candidate);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile()) return absolute;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Reads package.json `bin`/`main` when present; useful for upstream layouts. */
export async function readPackageEntry(root: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(text) as { bin?: unknown; main?: unknown };
    const bin = pkg.bin;
    if (typeof bin === 'string') return path.resolve(root, bin);
    if (bin && typeof bin === 'object') {
      const first = Object.values(bin as Record<string, unknown>).find((v) => typeof v === 'string');
      if (typeof first === 'string') return path.resolve(root, first);
    }
    if (typeof pkg.main === 'string') return path.resolve(root, pkg.main);
  } catch {
    // No usable manifest.
  }
  return undefined;
}
