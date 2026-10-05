/**
 * Structured logger with mandatory secret redaction (SPEC 7.2, 8.1).
 * No Cookie, token, auth header, or environment value may reach log output.
 */

import type { Logger } from './types.js';

const SECRET_KEY_PATTERN = /cookie|token|secret|authorization|password|credential|apikey|api_key|session/i;

/** Keys whose values are always replaced, regardless of content. */
const FORBIDDEN_KEYS = new Set(['config', 'env', 'environment', 'processenv']);

export interface LoggerOptions {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  sink?: (line: string) => void;
  /** Literal secret values to scrub even if they appear inside messages. */
  secretValues?: string[];
}

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function scrubString(value: string, secretValues: string[]): string {
  let out = value;
  for (const secret of secretValues) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

export function redactValue(value: unknown, secretValues: string[] = [], depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value, secretValues);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secretValues, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message, secretValues) };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        out[key] = '[REDACTED_OBJECT]';
        continue;
      }
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = item === undefined || item === null ? item : '[REDACTED]';
        continue;
      }
      out[key] = redactValue(item, secretValues, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.UNIFIED_TRIAL_LOG_LEVEL as LoggerOptions['level']) ?? 'info';
  const threshold = LEVELS[level] ?? 20;
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const secretValues = options.secretValues ?? [];

  const emit = (eventLevel: keyof typeof LEVELS, event: string, fields?: Record<string, unknown>) => {
    if ((LEVELS[eventLevel] ?? 20) < threshold) return;
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: eventLevel,
      event: scrubString(event, secretValues),
    };
    if (fields) payload['fields'] = redactValue(fields, secretValues);
    sink(JSON.stringify(payload));
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
