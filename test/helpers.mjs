import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location, never hardcoded: an absolute path would
// pass on the author's machine and fail in CI or any other checkout.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const DIST = path.join(ROOT, 'dist', 'src');

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

/**
 * Write a stub upstream MCP server that speaks the real stdio protocol.
 *
 * The body is wrapped in the imports a server needs, so each test only supplies
 * the request handlers it cares about. The adapter spawns this with
 * `process.execPath` and `cwd` set to the package dir, so the SDK has to resolve
 * from there - hence the `node_modules` symlink back to this checkout. Without
 * it the child dies on `ERR_MODULE_NOT_FOUND` and the test would be asserting
 * against a crash rather than against the adapter's behaviour.
 */
export async function stubUpstreamServer(dir, body) {
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'ut-stub-upstream', version: '1.0.0', type: 'module', main: 'dist/index.js' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'dist', 'index.js'),
    [
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
      "import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
      body,
    ].join('\n'),
    'utf8',
  );
  const link = path.join(dir, 'node_modules');
  try {
    await fs.symlink(path.join(ROOT, 'node_modules'), link, 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return dir;
}
