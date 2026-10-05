/**
 * Configuration loader (SPEC 8.2).
 *
 * Three distinct concerns:
 *  - static registry config: lives in code (registry.ts), not in the config file
 *  - path config: user supplied absolute paths, validated readable + allowlisted
 *  - secret config: read only from env or a permission-restricted file
 *
 * Nothing in this file is writable through MCP tool arguments.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResolvedPaths, SecretAccessor } from './types.js';

export const CONFIG_FILE_NAME = 'unified-trial-mcp.config.json';

/**
 * Secrets live apart from the JSON config so the config file stays free of
 * credentials and can be copied or committed without leaking anything.
 */
export const COOKIE_ENV_FILE_NAME = 'cookie.env';

/** Environment variables that may hold secrets; never serialized. */
export const SECRET_ENV_KEYS = ['CHINADRUGTRIALS_COOKIE', 'CDT_COOKIE'] as const;

export interface PathConfig {
  ictrpBundle?: string;
  ctvDatabase?: string;
  ctvMcpServer?: string;
  ctvCsvExport?: string;
  chictrCorpus?: string;
  chictrMcpServer?: string;
  xybArchive?: string;
  chinadrugtrialsArchive?: string;
  evidenceRoots?: string[];
  configDir?: string;
  workDir?: string;
}

export interface LoadedConfig {
  paths: ResolvedPaths;
  secrets: SecretAccessor;
  configPath?: string;
  warnings: string[];
}

export function defaultConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, 'unified-trial-mcp');
  return path.join(os.homedir(), '.unified-trial-mcp');
}

export function defaultWorkDir(): string {
  return path.join(defaultConfigDir(), 'work');
}

/** Deps injected so tests never need the real filesystem or environment. */
export interface ConfigDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (file: string) => Promise<string>;
  homedir?: string;
}

async function readJsonFile(file: string, deps: ConfigDeps): Promise<Record<string, unknown> | undefined> {
  const reader = deps.readFile ?? ((f: string) => fs.readFile(f, 'utf8'));
  try {
    const text = await reader(file);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new Error(`配置文件无法解析：${file}: ${(error as Error).message}`);
  }
}

function pickString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Reads `export NAME=value` lines from the Cookie env file written by
 * `configure`. Parsing is deliberately strict and never logs a value: a
 * malformed file must degrade to "not configured", never to a bogus secret.
 */
async function readEnvFile(file: string, deps: ConfigDeps): Promise<Record<string, string> | undefined> {
  const reader = deps.readFile ?? ((f: string) => fs.readFile(f, 'utf8'));
  let text: string;
  try {
    text = await reader(file);
  } catch {
    return undefined; // Missing or unreadable: simply not configured.
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    let value = match[2]!.trim();
    // Strip one layer of matching single or double quotes.
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (value) out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function pickStringArray(source: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = source?.[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return items.length ? items : undefined;
}

/**
 * Merges `overrides` into the on-disk config and writes it back, preserving any
 * keys already present so a later call never drops an earlier setting.
 *
 * Shared by `configure` and `bootstrap` so that mounting a path has exactly one
 * implementation. Returns the file that was written.
 */
export async function mergeAndWriteConfig(
  configDir: string,
  overrides: PathConfig,
  deps: ConfigDeps = {},
): Promise<string> {
  const writer = fs.writeFile;
  const reader = deps.readFile ?? ((f: string) => fs.readFile(f, 'utf8'));
  const configPath = path.join(configDir, CONFIG_FILE_NAME);

  // Refuse to clobber a file we cannot parse: silently discarding a user's
  // existing configuration is worse than failing loudly.
  let existing: Record<string, unknown> = {};
  try {
    const text = await reader(configPath);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`现有配置文件无法解析，已中止以免覆盖：${configPath}: ${(error as Error).message}`);
    }
  }

  const existingPaths = (existing['paths'] ?? {}) as Record<string, unknown>;
  const nextPaths: Record<string, unknown> = { ...existingPaths };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'configDir' || value === undefined) continue;
    nextPaths[key] = value;
  }

  const next = { ...existing, paths: nextPaths, updatedAt: new Date().toISOString() };
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await writer(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return configPath;
}

export async function loadConfig(overrides: PathConfig = {}, deps: ConfigDeps = {}): Promise<LoadedConfig> {
  const env = deps.env ?? process.env;
  const warnings: string[] = [];

  const envConfigDir = env.UNIFIED_TRIAL_CONFIG_DIR?.trim() || undefined;
  const configDir = path.resolve(overrides.configDir ?? envConfigDir ?? defaultConfigDir());
  const configPath = path.join(configDir, CONFIG_FILE_NAME);

  const fileConfig = await readJsonFile(configPath, deps);

  // A Cookie written by `configure` lives in a separate 0600 env file rather
  // than the JSON config, so that the config file stays secret-free and safe to
  // copy around. Real environment variables still win over the file.
  const envFilePath = path.join(configDir, COOKIE_ENV_FILE_NAME);
  const fileSecrets = await readEnvFile(envFilePath, deps);
  if (fileSecrets) warnings.push(`已从 ${envFilePath} 读取会话 Cookie（仅按需读取，从不输出其值）。`);

  const mergedEnv: NodeJS.ProcessEnv = { ...fileSecrets, ...env };
  const filePaths = (fileConfig?.paths ?? undefined) as Record<string, unknown> | undefined;

  const resolve = (key: keyof PathConfig, fileKey: string): string | undefined => {
    const fromOverride = overrides[key];
    const value = typeof fromOverride === 'string' ? fromOverride : pickString(filePaths, fileKey);
    return value ? path.resolve(value) : undefined;
  };

  const evidenceRootsRaw =
    overrides.evidenceRoots ?? pickStringArray(filePaths, 'evidenceRoots') ?? [];
  const evidenceRoots = evidenceRootsRaw.map((root) => path.resolve(root));

  const workDir = path.resolve(overrides.workDir ?? pickString(filePaths, 'workDir') ?? defaultWorkDir());

  const paths: ResolvedPaths = {
    configDir,
    workDir,
    evidenceRoots,
  };

  const ictrpBundle = resolve('ictrpBundle', 'ictrpBundle');
  if (ictrpBundle) paths.ictrpBundle = ictrpBundle;
  const ctvDatabase = resolve('ctvDatabase', 'ctvDatabase');
  if (ctvDatabase) paths.ctvDatabase = ctvDatabase;
  const ctvMcpServer = resolve('ctvMcpServer', 'ctvMcpServer');
  if (ctvMcpServer) paths.ctvMcpServer = ctvMcpServer;
  const ctvCsvExport = resolve('ctvCsvExport', 'ctvCsvExport');
  if (ctvCsvExport) paths.ctvCsvExport = ctvCsvExport;
  const chictrCorpus = resolve('chictrCorpus', 'chictrCorpus');
  if (chictrCorpus) paths.chictrCorpus = chictrCorpus;
  const chictrMcpServer = resolve('chictrMcpServer', 'chictrMcpServer');
  if (chictrMcpServer) paths.chictrMcpServer = chictrMcpServer;
  const xybArchive = resolve('xybArchive', 'xybArchive');
  if (xybArchive) paths.xybArchive = xybArchive;
  const chinadrugtrialsArchive = resolve('chinadrugtrialsArchive', 'chinadrugtrialsArchive');
  if (chinadrugtrialsArchive) paths.chinadrugtrialsArchive = chinadrugtrialsArchive;

  // Archive roots are also readable evidence roots.
  for (const candidate of [xybArchive, chinadrugtrialsArchive, ictrpBundle, ctvMcpServer, chictrMcpServer]) {
    if (candidate && !evidenceRoots.includes(candidate)) evidenceRoots.push(candidate);
  }
  // A corpus file's directory is an evidence root for raw HTML siblings.
  if (chictrCorpus) {
    const dir = path.dirname(chictrCorpus);
    if (!evidenceRoots.includes(dir)) evidenceRoots.push(dir);
  }
  // A CTV index database's directory is likewise an evidence root.
  if (ctvDatabase) {
    const dir = path.dirname(ctvDatabase);
    if (!evidenceRoots.includes(dir)) evidenceRoots.push(dir);
  }
  // A configured CTV CSV export file's directory is readable for the importer.
  if (ctvCsvExport) {
    const dir = path.dirname(ctvCsvExport);
    if (!evidenceRoots.includes(dir)) evidenceRoots.push(dir);
  }
  paths.evidenceRoots = evidenceRoots;

  const secretValues: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = mergedEnv[key];
    if (value && value.trim()) secretValues.push(value.trim());
  }

  const secrets: SecretAccessor = {
    get: (name) => {
      const value = mergedEnv[name];
      return value && value.trim() ? value.trim() : undefined;
    },
    has: (name) => Boolean(mergedEnv[name] && mergedEnv[name]!.trim()),
  };

  if (!fileConfig && !overrides.configDir && !envConfigDir) {
    warnings.push(`未找到配置文件 ${configPath}；使用默认路径与空配置。`);
  }

  const loaded: LoadedConfig = { paths, secrets, warnings };
  if (fileConfig) loaded.configPath = configPath;
  return loaded;
}

/**
 * Validates that a path exists and is readable, and that it is inside one of
 * the allowlisted roots. Returns a diagnostic instead of throwing so callers
 * can map it onto NEEDS_SETUP.
 */
export async function checkPathReadable(
  target: string,
  allowedRoots: string[],
  kind: 'file' | 'dir',
  deps: { stat?: (p: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>; access?: (p: string) => Promise<void> } = {},
): Promise<{ ok: true } | { ok: false; reasonCode: string; message: string; fixHint: string }> {
  const stat = deps.stat ?? ((p: string) => fs.stat(p));
  const access = deps.access ?? ((p: string) => fs.access(p, fs.constants.R_OK));
  const absolute = path.resolve(target);

  const inside = allowedRoots.some((root) => {
    const rel = path.relative(path.resolve(root), absolute);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!inside) {
    return {
      ok: false,
      reasonCode: 'PATH_NOT_ALLOWLISTED',
      message: `路径不在允许的根目录之内：${absolute}`,
      fixHint: '通过 configure 指定合法的归档/语料根目录后重试。',
    };
  }

  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        reasonCode: 'PATH_MISSING',
        message: `路径不存在：${absolute}`,
        fixHint: kind === 'file' ? '通过 configure 指向正确的文件，或先运行 bootstrap。' : '通过 configure 指向正确的目录。',
      };
    }
    return {
      ok: false,
      reasonCode: 'PATH_STAT_FAILED',
      message: `无法读取路径信息：${absolute}`,
      fixHint: '检查文件系统权限。',
    };
  }

  if (kind === 'file' && !info.isFile()) {
    return { ok: false, reasonCode: 'PATH_NOT_A_FILE', message: `不是文件：${absolute}`, fixHint: '提供一个具体文件路径。' };
  }
  if (kind === 'dir' && !info.isDirectory()) {
    return { ok: false, reasonCode: 'PATH_NOT_A_DIR', message: `不是目录：${absolute}`, fixHint: '提供一个目录路径。' };
  }

  try {
    await access(absolute);
  } catch {
    return { ok: false, reasonCode: 'PATH_NOT_READABLE', message: `路径不可读：${absolute}`, fixHint: '修正文件权限后重试。' };
  }

  return { ok: true };
}
