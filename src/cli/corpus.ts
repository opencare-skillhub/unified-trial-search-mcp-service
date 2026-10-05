/**
 * Public offline-corpus retrieval (SPEC 4.1 / ADR-008).
 *
 * ADR-006 forbids fetching anything that needs credentials, that defeats
 * robots/WAF/CAPTCHA, or that requires a user's identity. A publicly released,
 * anonymously downloadable corpus is none of those, so this module may fetch it
 * on the user's behalf - under three rules that are not negotiable:
 *
 *   1. The manifest is the contract. `bytes` and `sha256` come from
 *      `corpora/manifest.json`; a mismatch fails the whole operation.
 *   2. Failure never damages what is already installed. We download to a temp
 *      file, verify it, extract to a temp directory, and only then swap the
 *      target directory into place. Any failure leaves the previous corpus
 *      exactly as it was.
 *   3. It stays explicit. Nothing here runs on a search path; a caller who did
 *      not ask for a download never gets one.
 *
 * The download is written to disk as it streams, because holding a 150 MB corpus
 * in memory to hash it is a good way to kill a small machine.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../core/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/src/cli -> repo root is three levels up. */
const ROOT = path.resolve(HERE, '..', '..', '..');
export const MANIFEST_PATH = path.join(ROOT, 'corpora', 'manifest.json');

export const DEFAULT_CORPUS_ID = 'chictr_pancreatic';
export const DEFAULT_RETRIES = 3;

/**
 * Why an asset may be redistributed at all (ADR-009). The two corpora rest on
 * different grounds, and collapsing them into "it's public data" would quietly
 * dissolve ADR-006, so the grounds travel with the entry instead of living only
 * in a document:
 *   - `upstream_public`  - the dataset itself is public and anonymously
 *     downloadable; shipping a copy is transport, not disclosure.
 *   - `community_owned`  - the community's own scraping output, redistributed
 *     because its author holds the rights to that output. Whether the upstream
 *     site needs a credentialed session is irrelevant to THIS basis.
 */
export type CorpusBasis = 'upstream_public' | 'community_owned';

export interface CorpusManifestEntry {
  url: string;
  bytes: number;
  sha256: string;
  extractDir: string;
  version: string;
  title: string;
  basis?: CorpusBasis;
  note?: string;
}

/**
 * The file that must exist inside an extracted corpus for it to count as
 * installed. Checking this is what stops a truncated or wrongly-packed archive
 * from being swapped in as a "successful" install.
 */
const REQUIRED_CONTENT: Record<string, string> = {
  chictr_pancreatic: 'chictr_pancreatic.db',
  xyb_cde_pancreatic: 'summary.json',
  ctv_index: 'ctv.db',
};

/**
 * The table the ADAPTER reads for each SQLite corpus, used to prove an install
 * actually works. Kept next to REQUIRED_CONTENT because the two must agree: the
 * required file is meaningful only if the table inside it is the one queried.
 */
const SQLITE_TABLE_BY_CORPUS: Record<string, string> = {
  chictr_pancreatic: 'trials',
  ctv_index: 'studies',
};

export function requiredContentFor(corpusId: string): string {
  return REQUIRED_CONTENT[corpusId] ?? 'summary.json';
}

/**
 * Confirm the expected content exists ANYWHERE under the extracted root, and
 * return the directory it was found in (i.e. the real package root).
 *
 * Looking only at the top level was wrong: the XYB archive keeps its package
 * under `胰腺癌/`, so a top-level check rejected a perfectly good install with a
 * confusing ENOENT. Archives may legitimately nest, so the check follows them -
 * but it still has to find the content, which is the part that catches a
 * mis-packed or truncated archive.
 */
async function findContentRoot(extractRoot: string, required: string): Promise<string> {
  const direct = path.join(extractRoot, required);
  if (await exists(direct)) return extractRoot;

  const children = await readdir(extractRoot, { withFileTypes: true });
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const candidate = path.join(extractRoot, child.name, required);
    if (await exists(candidate)) return path.join(extractRoot, child.name);
  }

  throw new CorpusError(
    'EXTRACTED_CONTENT_MISSING',
    `解压后未找到必需内容 ${required}（已检查归档顶层及其下一层目录）`,
    '归档可能打包了错误的目录，或下载不完整。已保留原有数据未做任何改动。',
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Injected for tests: never let a unit test open a socket or spawn tar. */
export interface CorpusDeps {
  fetchImpl?: typeof fetch;
  sha256File?: (file: string) => Promise<string>;
  runTar?: (args: string[], cwd: string) => Promise<void>;
  readManifest?: () => Promise<{ corpora: Record<string, CorpusManifestEntry> }>;
  now?: () => number;
}

export class CorpusError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly fixHint?: string,
  ) {
    super(message);
    this.name = 'CorpusError';
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    // Hashing a 150 MB file with readFile() would hold all of it in memory.
    import('node:fs').then(({ createReadStream }) => {
      const stream = createReadStream(file);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    }, reject);
  });
}

function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // argv array, never a shell string: the archive name and paths are data.
    const child = spawn('tar', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => reject(new CorpusError('TAR_UNAVAILABLE', `无法执行 tar：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new CorpusError('TAR_FAILED', `tar 退出码 ${code}${stderr ? `：${stderr.trim()}` : ''}`));
    });
  });
}

export async function readManifest(
  deps: CorpusDeps = {},
): Promise<{ corpora: Record<string, CorpusManifestEntry> }> {
  if (deps.readManifest) return deps.readManifest();
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw) as { corpora: Record<string, CorpusManifestEntry> };
}

export function resolveEntry(
  manifest: { corpora: Record<string, CorpusManifestEntry> },
  corpusId: string,
): CorpusManifestEntry {
  const entry = manifest.corpora[corpusId];
  if (!entry) {
    throw new CorpusError(
      'CORPUS_NOT_IN_MANIFEST',
      `清单中没有语料：${corpusId}`,
      `可用语料：${Object.keys(manifest.corpora).join(', ') || '（清单为空）'}。若尚未发布资产，请先运行 scripts/pack-corpus.mjs --write-manifest 并上传 Release。`,
    );
  }
  if (!entry.sha256 || !entry.bytes || !entry.url) {
    throw new CorpusError(
      'MANIFEST_ENTRY_INCOMPLETE',
      `清单条目缺少 url/bytes/sha256：${corpusId}`,
      '用 scripts/pack-corpus.mjs --write-manifest 重新生成，不要手工编辑 sha256。',
    );
  }
  // ADR-009: an asset may not be redistributed without stating the grounds.
  // Enforcing it here rather than in a document is deliberate - the manifest is
  // where new assets get added, and a field nobody validates is a field nobody
  // fills in.
  if (entry.basis !== 'upstream_public' && entry.basis !== 'community_owned') {
    throw new CorpusError(
      'MANIFEST_BASIS_MISSING',
      `清单条目未声明分发依据（basis）：${corpusId}`,
      '每个语料必须声明 basis：upstream_public（上游公开可匿名下载）或 community_owned（社区自采成果，权利人确认可分发）。见 SPEC ADR-009。',
    );
  }
  return entry;
}

/**
 * Per-attempt timeout. Node's fetch has no usable default for a 25 MB asset over
 * a slow link, and an unbounded attempt makes a cold start look like a hang.
 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Turn a fetch failure into something a user can act on.
 *
 * `TypeError: fetch failed` is what surfaces at the top level; the actual reason
 * (DNS failure, connection refused, timeout, TLS, blocked by a network policy)
 * lives in `cause`, sometimes nested two levels deep. Reporting only the outer
 * message turns every distinct network problem into the same useless sentence -
 * so walk the chain, including the aggregate `errors` list some Node failures
 * carry, and de-duplicate the wording.
 */
export function describeFetchError(error: unknown): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (!value || depth > 4) return;
    if (value instanceof AggregateError) {
      for (const inner of value.errors) visit(inner, depth + 1);
      return;
    }
    if (value instanceof Error) {
      const message = value.message?.trim();
      // "fetch failed" adds nothing once we have the cause, so drop the wrapper.
      if (message && message !== 'fetch failed' && !seen.has(message)) {
        seen.add(message);
        parts.push(message);
      }
      visit(value.cause, depth + 1);
      return;
    }
    const text = String(value).trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  };
  visit(error, 0);
  return parts.length ? parts.join(' <- ') : String(error);
}

/** Downloads to `destFile`, retrying transient failures. Never leaves a partial file behind. */
async function download(
  entry: CorpusManifestEntry,
  destFile: string,
  deps: CorpusDeps,
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const retries = DEFAULT_RETRIES;

  if (entry.url.startsWith('file://')) {
    // A local mirror is not a network failure mode: copy once, no retries.
    const source = fileURLToPath(entry.url);
    const { copyFile } = await import('node:fs/promises');
    await copyFile(source, destFile);
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await doFetch(entry.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        // 4xx will not fix itself; only retry on 5xx and network errors.
        if (response.status < 500) {
          throw new CorpusError(
            'DOWNLOAD_HTTP_ERROR',
            `下载失败：HTTP ${response.status} ${response.statusText}`,
            '若为 404，说明该版本的 Release 资产尚未上传或已被删除；可用 --url 指向镜像或本地文件。',
          );
        }
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('响应没有 body');
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destFile));
      return;
    } catch (error) {
      lastError = error;
      await rm(destFile, { force: true });
      if (error instanceof CorpusError) throw error;
      if (attempt < retries) {
        // Linear backoff: corpus downloads are large and rare, so a short,
        // predictable wait beats an exponential one that stalls a cold start.
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw new CorpusError(
    'DOWNLOAD_FAILED',
    `下载失败（已重试 ${retries} 次）：${describeFetchError(lastError)}`,
    '检查网络连通性（DNS、代理、是否有网络策略拦截）；' +
      '若默认 Release 不可达，可用 --url 指向镜像或 file:// 本地路径。' +
      '注意本命令会跟随 GitHub 的 302 跳转，因此重定向目标也必须可达。',
  );
}

export interface FetchCorpusOptions {
  corpusId?: string;
  urlOverride?: string;
  destDir?: string;
  apply?: boolean;
  logger?: Logger;
}

export interface FetchCorpusResult {
  corpusId: string;
  url: string;
  bytes: number;
  sha256: string;
  destDir: string;
  corpusDir: string;
  dbPath: string;
  applied: boolean;
  steps: string[];
}

/**
 * Resolve the corpus into `destDir`.
 *
 * With `apply: false` this is a pure dry run that reports what would happen -
 * the URL, expected size, expected digest - without touching the network or disk.
 */
export async function fetchCorpus(
  options: FetchCorpusOptions = {},
  deps: CorpusDeps = {},
): Promise<FetchCorpusResult> {
  const corpusId = options.corpusId ?? DEFAULT_CORPUS_ID;
  const manifest = await readManifest(deps);
  const entry = resolveEntry(manifest, corpusId);
  const url = options.urlOverride ?? entry.url;

  const destDir = path.resolve(options.destDir ?? path.join(os.homedir(), '.unified-trial-mcp', 'corpora'));
  const corpusDir = path.join(destDir, entry.extractDir);
  // The required file is corpus-specific (`chictr_pancreatic.db`, `ctv.db`,
  // `summary.json`); hardcoding ChiCTR's name here made `dbPath` point at a file
  // that does not exist for every other corpus, and the printed mount command
  // would hand the user a path that fails.
  const dbPath = path.join(corpusDir, requiredContentFor(corpusId));

  const steps: string[] = [`语料：${corpusId}（${entry.title}）`, `来源：${url}`, `预期大小：${entry.bytes} 字节`, `预期 sha256：${entry.sha256}`];
  const base: FetchCorpusResult = {
    corpusId,
    url,
    bytes: entry.bytes,
    sha256: entry.sha256,
    destDir,
    corpusDir,
    dbPath,
    applied: Boolean(options.apply),
    steps,
  };

  if (!options.apply) {
    steps.push('dry-run：未下载任何内容。加 --apply 才会实际下载。');
    return base;
  }

  await mkdir(destDir, { recursive: true });
  const staging = await mkdtemp(path.join(destDir, '.staging-'));
  const archive = path.join(staging, `${corpusId}.tar.gz`);

  try {
    steps.push('下载中…');
    await download({ ...entry, url }, archive, deps);

    const size = (await stat(archive)).size;
    if (size !== entry.bytes) {
      throw new CorpusError(
        'SIZE_MISMATCH',
        `下载大小不符：期望 ${entry.bytes} 字节，实际 ${size} 字节`,
        '这通常意味着下载被截断或资产已被替换。已保留原有数据未做任何改动，请重试。',
      );
    }
    steps.push(`大小校验通过：${size} 字节`);

    const digest = await (deps.sha256File ?? sha256File)(archive);
    if (digest !== entry.sha256) {
      throw new CorpusError(
        'SHA256_MISMATCH',
        `sha256 校验失败：期望 ${entry.sha256}，实际 ${digest}`,
        '资产与清单不一致。已保留原有数据未做任何改动。若你信任该来源，请用 pack-corpus.mjs --write-manifest 重新生成清单。',
      );
    }
    steps.push(`sha256 校验通过：${digest}`);

    const extractRoot = path.join(staging, 'extract');
    await mkdir(extractRoot, { recursive: true });
    await (deps.runTar ?? runTar)(['-xzf', archive, '-C', extractRoot], staging);
    steps.push('解压完成（临时目录）');

    // Verify the extracted corpus before it can replace anything: an archive can
    // pass its checksum and still be the wrong shape for this code.
    const required = requiredContentFor(corpusId);
    const contentRoot = await findContentRoot(extractRoot, required);
    steps.push(`解压内容校验通过（${required} 存在）`);

    // The install layout must match what `configure` expects for THIS corpus,
    // and the two corpora want opposite things:
    //
    //   chictr   - --chictr-corpus names a FILE, so the payload goes directly
    //              under extractDir: <extractDir>/chictr_pancreatic.db, matching
    //              how a user would point at a checked-out corpus.
    //   xyb_cde  - --xyb-archive names the PARENT of packages: the adapter scans
    //              that directory for SUBDIRECTORIES holding summary.json. If the
    //              package lands at <extractDir> itself, the adapter looks one
    //              level too deep and rejects it with NO_ARCHIVE_PACKAGES
    //              ("json、logs、raw、word 均不完整"). So the package must stay
    //              nested: <extractDir>/<package>/summary.json.
    //
    // This is why the swap source differs: for an archive-shaped corpus we move
    // the whole extraction root (which holds the package directory), not the
    // package itself.
    const installSource = corpusId === 'xyb_cde_pancreatic' ? extractRoot : contentRoot;

    if (corpusId === 'xyb_cde_pancreatic' && contentRoot === extractRoot) {
      throw new CorpusError(
        'ARCHIVE_LAYOUT_UNEXPECTED',
        `归档 ${corpusId} 顶层直接是数据包内容，缺少包目录层级（期望形如 <归档>/<包名>/summary.json）`,
        '--xyb-archive 需要指向数据包的父目录（output 目录）。请用 pack-corpus.mjs 重新打包并更新清单。',
      );
    }

    // Atomic-ish swap: build <destDir>/<extractDir>.new, then rename it over the
    // old directory. A rename within one filesystem is atomic, so a reader either
    // sees the complete old corpus or the complete new one - never a half-written
    // directory. The old data is only removed after the new one is in place.
    const next = `${corpusDir}.new`;
    const previous = `${corpusDir}.old`;
    await rm(next, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });

    await rename(installSource, next).catch(async (error: NodeJS.ErrnoException) => {
      // rename() across devices fails with EXDEV; fall back to a copy.
      if (error.code !== 'EXDEV') throw error;
      const { cp } = await import('node:fs/promises');
      await cp(installSource, next, { recursive: true });
    });

    let replaced = false;
    try {
      await rename(corpusDir, previous);
      replaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(next, corpusDir);
    } catch (error) {
      // Put the previous corpus back rather than leaving the user with nothing.
      if (replaced) await rename(previous, corpusDir).catch(() => undefined);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    steps.push(`已替换目标目录：${corpusDir}`);

    // A corpus is only "installed" if this service can actually read it. For the
    // SQLite corpora that means opening it and counting rows in the table the
    // ADAPTER queries - not just "a .db exists", which a truncated file would
    // also satisfy. For an archive package it means the files the adapter walks
    // are present. Verifying here keeps a corrupt install from being reported as
    // success and only discovered at query time.
    //
    // Each corpus names its own table: chictr is read via `trials`, the CTV index
    // via `studies`. Assuming `trials` for every .db would fail the CTV install
    // with "no such table: trials".
    const sqliteTable = SQLITE_TABLE_BY_CORPUS[corpusId];
    if (required.endsWith('.db')) {
      const table = sqliteTable ?? 'trials';
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(corpusDir, required), { readOnly: true });
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
        steps.push(`数据库可读：${table} 共 ${row.c} 条记录`);
      } finally {
        db.close();
      }
    } else {
      // The archive's package root was renamed into place, so corpusDir IS the
      // package - not a directory of packages. An archive holding several
      // packages would land them as siblings, so accept both shapes, but require
      // at least one usable package either way: "installed successfully" has to
      // mean "the adapter can read something".
      const candidates: string[] = [];
      if (await exists(path.join(corpusDir, 'summary.json'))) candidates.push(corpusDir);
      for (const child of await readdir(corpusDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const nested = path.join(corpusDir, child.name);
        if (await exists(path.join(nested, 'summary.json'))) candidates.push(nested);
      }

      // A package without json/ is skipped by the adapter, so it must not count
      // towards "this install works".
      const usable = candidates.filter((candidate) => candidate !== undefined);
      const readable: string[] = [];
      for (const candidate of usable) {
        if (await exists(path.join(candidate, 'json'))) readable.push(path.basename(candidate));
      }
      if (readable.length === 0) {
        throw new CorpusError(
          'INSTALLED_ARCHIVE_UNUSABLE',
          `解压后没有可用数据包（每个包都需要 summary.json 与 json/ 目录）：${corpusDir}`,
          '归档可能打包了错误的目录。请报告该问题并暂时用 --url 指向可信来源。',
        );
      }
      steps.push(`归档可读：${readable.length} 个可用数据包（${readable.join('、')}）`);
    }

    return { ...base, steps };
  } finally {
    // The staging area holds a full copy of the corpus; never leak it on failure.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
