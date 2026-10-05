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
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
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

export interface CorpusManifestEntry {
  url: string;
  bytes: number;
  sha256: string;
  extractDir: string;
  version: string;
  title: string;
  note?: string;
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
  return entry;
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
      const response = await doFetch(entry.url, { redirect: 'follow' });
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
    `下载失败（已重试 ${retries} 次）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    '检查网络连通性；若默认 Release 不可达，可用 --url 指向镜像或 file:// 本地路径。',
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
  const dbPath = path.join(corpusDir, 'chictr_pancreatic.db');

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
    await stat(path.join(extractRoot, 'chictr_pancreatic.db'));
    steps.push('解压内容校验通过');

    // Atomic-ish swap: build <destDir>/<extractDir>.new, then rename it over the
    // old directory. A rename within one filesystem is atomic, so a reader either
    // sees the complete old corpus or the complete new one - never a half-written
    // directory. The old data is only removed after the new one is in place.
    const next = `${corpusDir}.new`;
    const previous = `${corpusDir}.old`;
    await rm(next, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
    await rename(extractRoot, next).catch(async (error: NodeJS.ErrnoException) => {
      // rename() across devices fails with EXDEV; fall back to a copy.
      if (error.code !== 'EXDEV') throw error;
      const { cp } = await import('node:fs/promises');
      await cp(extractRoot, next, { recursive: true });
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

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM trials').get() as { c: number };
    db.close();
    steps.push(`数据库可读：trials 共 ${row.c} 条记录`);

    return { ...base, steps };
  } finally {
    // The staging area holds a full copy of the corpus; never leak it on failure.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
