import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIST = '/Users/qinxiaoqiang/Downloads/unified_search_trials/dist/src';

export async function load(rel) {
  return import(`${DIST}/${rel}`);
}

export async function tempDir(prefix = 'ut-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

/** Minimal descriptor stub so adapter contract tests stay hermetic. */
export function stubDescriptor(overrides = {}) {
  return {
    id: 'ictrp',
    label: 'stub',
    scope: 'stub',
    kind: 'mcp',
    enabledByDefault: true,
    queryTimeoutMs: 1000,
    maxResults: 200,
    staleAfterDays: 7,
    identityRule: 'stub',
    zeroResultMeaning: 'stub',
    ...overrides,
  };
}

export function silentCtx(paths, secrets = {}, timeoutMs = 5000) {
  return {
    signal: new AbortController().signal,
    timeoutMs,
    paths,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: (name) => secrets[name], has: (name) => secrets[name] !== undefined },
  };
}
