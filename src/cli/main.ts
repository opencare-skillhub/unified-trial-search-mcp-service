#!/usr/bin/env node
/**
 * Single-entry CLI (SPEC 4.1 / ADR-006).
 *
 *   unified-trial-mcp serve        start the MCP stdio server (the only entry a
 *                                  MCP client registers)
 *   unified-trial-mcp doctor       report readiness per source; exit 0/1/2
 *   unified-trial-mcp bootstrap    prepare missing pieces; dry run by default,
 *                                  `--apply` performs the work
 *   unified-trial-mcp configure    persist absolute paths for offline assets
 *
 * Safety invariants that this file must never violate:
 *  - bootstrap never obtains a Cookie, never writes one, never launches an
 *    interactive browser, and never bypasses Cookie/robots/WAF/CAPTCHA.
 *  - doctor only reports whether a Cookie is configured (present/absent), never
 *    its value.
 *  - no secret is ever printed, logged or persisted.
 */

import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILE_NAME, defaultConfigDir, loadConfig, type PathConfig } from '../core/config.js';
import {
  CorpusError,
  DEFAULT_CORPUS_ID,
  fetchCorpus,
  readManifest,
  resolveEntry,
} from './corpus.js';
import { formatCutoff } from '../core/cutoff.js';
import { createAdapters } from '../adapters/index.js';
import { Orchestrator } from '../core/orchestrator.js';
import { createLogger } from '../core/logger.js';
import { SOURCE_IDS } from '../core/registry.js';
import type { ResolvedPaths, SourceConclusion, SourceId } from '../core/types.js';
import { serveStdio } from '../tools/server.js';
import type { ToolDeps } from '../tools/handlers.js';
import { runBootstrap, type BootstrapOutcome } from './bootstrap.js';
import {
  acquireCookieFromEntryPage,
  extractCookieFromCurl,
  maskCookie,
  writeCookieEnvFile,
} from './cookie.js';

/** Parses `name=value; ...` into a plain object; used only for field counts. */
function parseCookieStringLocal(cookie: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0) out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
}

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...tail] = argv;
  const flags = new Map<string, string | boolean>();
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i += 1) {
    const token = tail[i]!;
    if (!token.startsWith('--')) {
      rest.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = tail[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { command, flags, rest };
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === 'true';
}

/** Splits `--sources a,b` into registry ids, rejecting unknown ones. */
function parseSources(raw: string | undefined): SourceId[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !(SOURCE_IDS as readonly string[]).includes(id));
  if (unknown.length) {
    throw new Error(`未注册的来源：${unknown.join(', ')}；可用来源：${SOURCE_IDS.join(', ')}`);
  }
  return ids as SourceId[];
}

function buildConfigOverrides(flags: Map<string, string | boolean>): PathConfig {
  const overrides: PathConfig = {};
  const map: Array<[string, keyof PathConfig]> = [
    ['ictrp-bundle', 'ictrpBundle'],
    ['ctv-database', 'ctvDatabase'],
    ['ctv-mcp-server', 'ctvMcpServer'],
    ['ctv-csv-export', 'ctvCsvExport'],
    ['chictr-corpus', 'chictrCorpus'],
    ['chictr-mcp-server', 'chictrMcpServer'],
    ['xyb-archive', 'xybArchive'],
    ['chinadrugtrials-archive', 'chinadrugtrialsArchive'],
    ['config-dir', 'configDir'],
    ['work-dir', 'workDir'],
  ];
  for (const [flag, key] of map) {
    const value = flagString(flags, flag);
    if (value) (overrides as Record<string, unknown>)[key] = value;
  }
  const roots = flagString(flags, 'evidence-roots');
  if (roots) overrides.evidenceRoots = roots.split(',').map((value) => value.trim()).filter(Boolean);
  return overrides;
}

function buildRuntime(loaded: { paths: ResolvedPaths; secrets: ReturnType<typeof loadConfig> extends Promise<infer T> ? (T extends { secrets: infer S } ? S : never) : never }) {
  const bundle = createAdapters({ paths: loaded.paths, secrets: loaded.secrets });
  const logger = createLogger({ level: 'info' });
  const orchestrator = new Orchestrator({
    adapters: bundle.adapters,
    paths: loaded.paths,
    secrets: loaded.secrets,
    logger,
  });
  const deps: ToolDeps = {
    bundle,
    orchestrator,
    paths: loaded.paths,
    secrets: loaded.secrets,
  };
  return { bundle, orchestrator, deps, logger };
}

const STATE_MARK: Record<string, string> = {
  SUCCESS: 'OK  ',
  NO_RESULTS: 'OK  ',
  NEEDS_SETUP: 'SET ',
  NOT_ENABLED: 'OFF ',
  NOT_QUERIED: '--  ',
  TIMEOUT: 'TIME',
  CHALLENGE_REQUIRED: 'CHAL',
  RATE_LIMITED: 'RATE',
  DENIED: 'DENY',
  FAILED: 'FAIL',
};

function renderStatuses(statuses: SourceConclusion[], json: boolean, extra?: Record<string, unknown>): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ statuses, ...(extra ?? {}) }, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  for (const status of statuses) {
    lines.push(`${STATE_MARK[status.state] ?? '?   '} ${status.sourceId.padEnd(30)} ${status.explanation}`);
    if (status.fixHint) lines.push(`      ↳ ${status.fixHint}`);
    for (const warning of status.completeness.warnings) lines.push(`      ! ${warning}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function doctorExitCode(statuses: SourceConclusion[]): number {
  // 0 = every source ready; 2 = at least one source unusable; 1 = degraded but
  // every registered source is at least queryable.
  const hard = statuses.filter((status) => ['FAILED', 'NEEDS_SETUP', 'NOT_ENABLED', 'DENIED', 'CHALLENGE_REQUIRED'].includes(status.state));
  if (hard.length === 0) return 0;
  const ready = statuses.filter((status) => status.state === 'SUCCESS').length;
  return ready > 0 && hard.length < statuses.length ? 1 : 2;
}

/**
 * Guidance printed when ChinaDrugTrials cannot talk to the site. New
 * environments must not be left guessing: this always names a concrete next
 * command — the automatic one first, the manual fallback second.
 */
function cookieGuidance(status: SourceConclusion, configDir: string): string[] {
  const needsCookie =
    status.sourceId === 'chinadrugtrials' &&
    (status.state === 'NEEDS_SETUP' || status.state === 'DENIED' || status.state === 'CHALLENGE_REQUIRED' || status.state === 'FAILED');
  if (!needsCookie) return [];
  const missing = /COOKIE_MISSING|COOKIE_UNREADABLE/.test(status.reasonCode);
  const lines: string[] = [];
  lines.push(
    missing
      ? 'ChinaDrugTrials 尚未配置会话 Cookie。两种取得方式（任选其一）：'
      : 'ChinaDrugTrials 的会话 Cookie 可能已失效。两种刷新方式（任选其一）：',
  );
  lines.push('  方式一（自动，一次公开入口页访问，不绕过任何验证）：');
  lines.push(`    unified-trial-mcp configure --cookie-from-entry-page --config-dir ${configDir}`);
  lines.push('  方式二（人工，站点需要登录态或方式一失败时使用）：');
  lines.push('    在已能正常访问站点的浏览器中，对该站内请求「复制为 cURL」，然后：');
  lines.push(`    unified-trial-mcp configure --cookie-from-curl '<粘贴完整 cURL 命令>' --config-dir ${configDir}`);
  lines.push('  两种方式都会写入 <配置目录>/cookie.env（权限 0600）；启用方式：set -a; . <配置目录>/cookie.env; set +a');
  return lines;
}

async function commandDoctor(flags: Map<string, string | boolean>): Promise<number> {
  const json = flagBool(flags, 'json');
  const sources = parseSources(flagString(flags, 'sources'));
  const overrides = buildConfigOverrides(flags);
  const loaded = await loadConfig(overrides);
  const { orchestrator } = buildRuntime(loaded);
  const statuses = await orchestrator.status(sources, true);
  const code = doctorExitCode(statuses);

  if (!json) {
    process.stdout.write(`配置目录：${loaded.paths.configDir}\n`);
    if (loaded.configPath) process.stdout.write(`配置文件：${loaded.configPath}\n`);
    else process.stdout.write(`配置文件：未找到（使用默认路径）\n`);
  }
  renderStatuses(statuses, json, {
    exitCode: code,
    configDir: loaded.paths.configDir,
    ...(loaded.configPath ? { configPath: loaded.configPath } : {}),
    warnings: loaded.warnings,
  });
  if (!json) {
    const guidance = statuses.flatMap((status) => cookieGuidance(status, loaded.paths.configDir));
    if (guidance.length) process.stdout.write(`\n${guidance.join('\n')}\n`);
    process.stdout.write(
      `\n退出码 ${code}（0=全部就绪，1=部分未就绪，2=无可用来源）\n` +
        '提示：doctor 只报告 Cookie 是否已配置，从不读取或输出其值。\n',
    );
  }
  return code;
}

async function commandBootstrap(flags: Map<string, string | boolean>): Promise<number> {
  const json = flagBool(flags, 'json');
  const apply = flagBool(flags, 'apply');
  const sources = parseSources(flagString(flags, 'sources'));
  const overrides = buildConfigOverrides(flags);
  const loaded = await loadConfig(overrides);
  const { orchestrator } = buildRuntime(loaded);

  const before = await orchestrator.status(sources, false);
  const outcome: BootstrapOutcome = await runBootstrap({
    paths: loaded.paths,
    sourceIds: sources,
    apply,
    withCtvIndex: flagBool(flags, 'with-ctv-index'),
    maxPages: Number(flagString(flags, 'max-pages') ?? 1) || 1,
    keyword: flagString(flags, 'keyword'),
    dryRun: !apply,
  });
  const after = await orchestrator.status(sources, false);
  const code = doctorExitCode(after);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ applied: apply, before, steps: outcome.steps, after, exitCode: code }, null, 2)}\n`,
    );
    return code;
  }

  process.stdout.write(apply ? '初始化模式：--apply（将执行以下步骤）\n' : '演练模式（dry run）：不会做任何改动，加 --apply 才会执行。\n\n');
  for (const step of outcome.steps) {
    process.stdout.write(`[${step.status}] ${step.sourceId}: ${step.action}\n`);
    if (step.detail) process.stdout.write(`      ${step.detail}\n`);
    if (step.command) process.stdout.write(`      $ ${step.command}\n`);
  }
  process.stdout.write('\n初始化后状态：\n');
  renderStatuses(after, false);
  process.stdout.write(
    `\n退出码 ${code}\n` +
      '本服务不会自动获取 Cookie、不会写入 Cookie、不会启动交互式浏览器，也不会绕过 robots/WAF/验证码。\n',
  );
  return code;
}

/**
 * `fetch-corpus` (SPEC 4.1 / ADR-008): retrieve a publicly released offline
 * corpus.
 *
 * This is the one place the service is allowed to download data on the user's
 * behalf, and only because the asset is public, anonymous and checksum-verified.
 * It never fetches anything behind a credential or a challenge - that is still
 * ADR-006's line, and it has not moved.
 */
async function commandFetchCorpus(flags: Map<string, string | boolean>): Promise<number> {
  const json = flagBool(flags, 'json');
  const apply = flagBool(flags, 'apply');
  const corpusId = flagString(flags, 'corpus');
  const urlOverride = flagString(flags, 'url');
  const destDir = flagString(flags, 'dest');

  try {
    if (flagBool(flags, 'print-url')) {
      const manifest = await readManifest();
      const entry = resolveEntry(manifest, corpusId ?? DEFAULT_CORPUS_ID);
      process.stdout.write(`${urlOverride ?? entry.url}\n`);
      return 0;
    }

    const result = await fetchCorpus({ corpusId, urlOverride, destDir, apply });

    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    for (const step of result.steps) process.stdout.write(`${step}\n`);
    if (!result.applied) {
      process.stdout.write(
        `\n这是 dry run，未下载任何内容。确认无误后执行：\n  unified-trial-mcp fetch-corpus --corpus ${result.corpusId} --apply\n`,
      );
      return 0;
    }
    // Each corpus is mounted by a different configure flag; printing the ChiCTR
    // flag for the XYB archive would send users down a path that fails.
    const mount =
      result.corpusId === 'xyb_cde_pancreatic'
        ? `unified-trial-mcp configure --xyb-archive ${result.corpusDir}`
        : `unified-trial-mcp configure --chictr-corpus ${result.dbPath}`;
    process.stdout.write(
      `\n语料已就绪：${result.corpusDir}\n` + `下一步把它挂载为只读来源：\n  ${mount}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof CorpusError) {
      process.stderr.write(`错误：${error.message}\n`);
      if (error.fixHint) process.stderr.write(`提示：${error.fixHint}\n`);
      if (json) {
        process.stderr.write(
          `${JSON.stringify({ reasonCode: error.reasonCode, message: error.message }, null, 2)}\n`,
        );
      }
      return 1;
    }
    throw error;
  }
}

async function commandConfigure(flags: Map<string, string | boolean>): Promise<number> {
  const overrides = buildConfigOverrides(flags);
  const json = flagBool(flags, 'json');
  const configDir = path.resolve(
    flagString(flags, 'config-dir') ?? process.env.UNIFIED_TRIAL_CONFIG_DIR ?? defaultConfigDir(),
  );
  const configPath = path.join(configDir, CONFIG_FILE_NAME);

  // Cookie acquisition is a separate, explicit, one-shot action. It is the ONLY
  // place in this service allowed to obtain a Cookie, and it does so by one
  // ordinary GET of the site's public landing page — never by defeating a
  // challenge. `doctor`/`bootstrap` never call it.
  const fromEntryPage = flagBool(flags, 'cookie-from-entry-page');
  const fromCurl = flagString(flags, 'cookie-from-curl');
  const cookieKeyword = flagString(flags, 'cookie-check-keyword');
  let cookieReport: Record<string, unknown> | undefined;

  if (fromEntryPage || fromCurl) {
    let acquired: { cookie?: string; message?: string; reasonCode?: string; fixHint?: string; ok: boolean };
    if (fromCurl !== undefined || flags.has('cookie-from-curl')) {
      // Accept either an inline cURL string or a file containing one.
      let text = fromCurl ?? '';
      if (!text && flags.has('cookie-from-curl')) {
        const file = flagString(flags, 'cookie-from-curl-file');
        if (file) text = await fs.readFile(file, 'utf8');
      }
      const cookie = extractCookieFromCurl(text);
      acquired = cookie
        ? { ok: true, cookie, message: `已从 cURL 命令中提取 ${Object.keys(parseCookieStringLocal(cookie)).length} 个 Cookie 字段。` }
        : {
            ok: false,
            reasonCode: 'CURL_COOKIE_NOT_FOUND',
            message: '未能从提供的内容中解析出 Cookie。',
            fixHint: '请粘贴完整的「复制为 cURL」命令（含 -b 或 --cookie 参数），或包含 Cookie 请求头的 -H 参数。',
          };
    } else {
      acquired = await acquireCookieFromEntryPage({
        ...(cookieKeyword ? { keyword: cookieKeyword } : {}),
      });
    }

    if (!acquired.ok || !acquired.cookie) {
      cookieReport = {
        ok: false,
        reasonCode: acquired.reasonCode,
        message: acquired.message,
        fixHint: acquired.fixHint,
      };
      if (json) {
        process.stdout.write(`${JSON.stringify({ configPath, cookie: cookieReport }, null, 2)}\n`);
      } else {
        process.stderr.write(`Cookie 获取失败：${acquired.message}\n`);
        if (acquired.fixHint) process.stderr.write(`  ↳ ${acquired.fixHint}\n`);
      }
      // A failed acquisition is not a config write: report it and stop.
      return 1;
    }

    const envPath = await writeCookieEnvFile(configDir, acquired.cookie);
    cookieReport = {
      ok: true,
      envPath,
      fields: Object.keys(parseCookieStringLocal(acquired.cookie)).length,
      masked: maskCookie(acquired.cookie),
      message: acquired.message,
    };
    if (!json) {
      process.stdout.write(`${acquired.message}\n`);
      process.stdout.write(`已写入环境文件：${envPath}（权限 0600，含凭证，请勿提交版本库）\n`);
      process.stdout.write(`  ${maskCookie(acquired.cookie)}\n`);
      process.stdout.write(`启用方式：set -a; . ${envPath}; set +a\n\n`);
    }
  }

  // Merge with any existing file so configure never drops prior settings.
  let existing: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(configPath, 'utf8');
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
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  if (flagBool(flags, 'json')) {
    process.stdout.write(`${JSON.stringify({ configPath, paths: nextPaths }, null, 2)}\n`);
  } else {
    process.stdout.write(`已写入配置：${configPath}\n`);
    for (const [key, value] of Object.entries(nextPaths)) process.stdout.write(`  ${key} = ${String(value)}\n`);
    process.stdout.write('\n配置文件本身不含任何密钥；Cookie 存放在同目录的 cookie.env（0600），可用 --cookie-from-entry-page 获取。\n');
  }
  return 0;
}

async function commandServe(flags: Map<string, string | boolean>): Promise<number> {
  const overrides = buildConfigOverrides(flags);
  const loaded = await loadConfig(overrides);
  const { deps, logger } = buildRuntime(loaded);
  await serveStdio(deps, logger);
  return 0;
}

function usage(): void {
  process.stdout.write(
    [
      'unified-trial-mcp —— 统一临床试验检索 MCP 服务',
      '',
      '用法：',
      '  unified-trial-mcp serve                       启动 MCP stdio 服务（MCP Client 只需注册本命令）',
      '  unified-trial-mcp doctor [--sources a,b] [--json]',
      '                                                诊断各来源就绪状态；退出码 0/1/2',
      '  unified-trial-mcp bootstrap [--apply] [--sources a,b] [--with-ctv-index] [--json]',
      '                                                初始化缺失依赖；默认 dry run',
      '  unified-trial-mcp configure --xyb-archive <目录> --chictr-corpus <文件> ...',
      '                                                写入绝对路径配置',
      '  unified-trial-mcp fetch-corpus [--corpus <id>] [--url <url>] [--dest <目录>] [--apply] [--print-url] [--json]',
      '                                                获取公开发布的离线语料；默认 dry run，--apply 才下载并校验',
      '  unified-trial-mcp configure --cookie-from-entry-page',
      '                                                自动获取 ChinaDrugTrials 会话 Cookie（一次公开入口页访问）',
      "  unified-trial-mcp configure --cookie-from-curl '<cURL>'",
      '                                                从浏览器「复制为 cURL」中提取 Cookie（人工兜底）',
      '',
      'configure 支持的路径参数：',
      '  --ictrp-bundle <目录>            --ctv-database <文件>',
      '  --ctv-mcp-server <目录>          --ctv-csv-export <文件>',
      '  --chictr-corpus <文件>           --chictr-mcp-server <目录>',
      '  --xyb-archive <目录>             --chinadrugtrials-archive <目录>',
      '  --evidence-roots <a,b>           --config-dir <目录>  --work-dir <目录>',
      '  --cookie-check-keyword <关键词>  校验 Cookie 时使用的只读检索词（默认 胰腺癌）',
      '',
      `配置文件：$UNIFIED_TRIAL_CONFIG_DIR 或 ${defaultConfigDir()}/${CONFIG_FILE_NAME}`,
      '离线语料：fetch-corpus 只获取公开发布、可匿名下载的语料，强制 sha256 校验，',
      '         失败时保留原有数据不动；需要凭证或需绕过防护的数据绝不自动获取。',
      'Cookie：存放在 <配置目录>/cookie.env（权限 0600），由 configure 显式写入并校验；',
      '        doctor/bootstrap 只引导、绝不自动获取，也不绕过验证码或 WAF。',
      '',
    ].join('\n'),
  );
}

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case 'serve':
      return commandServe(flags);
    case 'doctor':
      return commandDoctor(flags);
    case 'bootstrap':
      return commandBootstrap(flags);
    case 'configure':
      return commandConfigure(flags);
    case 'fetch-corpus':
      return commandFetchCorpus(flags);
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      process.stderr.write(`未知命令：${command}\n\n`);
      usage();
      return 2;
  }
}

/**
 * Decide whether this module was launched as a program, rather than imported by
 * a test.
 *
 * The comparison must go through `realpath` on both sides. `npm install -g`
 * exposes the command as a SYMLINK in the global bin directory, so
 * `process.argv[1]` is the link path while `import.meta.url` is already the
 * resolved real path. Comparing them literally makes the two differ, and the
 * CLI then does nothing at all and exits 0 - a silent no-op that only appears
 * after installation, never when running the file directly from the source tree.
 */
function invokedAsProgram(): boolean {
  const self = fileURLToPath(import.meta.url);
  const entry = process.argv[1];
  if (!entry) return false;
  const resolvedEntry = path.resolve(entry);
  if (resolvedEntry === self) return true;
  try {
    return realpathSync(resolvedEntry) === realpathSync(self);
  } catch {
    // A missing or unreadable argv[1] cannot be this file.
    return false;
  }
}

if (invokedAsProgram()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 2;
    });
}
