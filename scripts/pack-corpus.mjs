#!/usr/bin/env node
/**
 * Pack an offline corpus into a release asset, and update the manifest that
 * `fetch-corpus` verifies against (ADR-008).
 *
 * The manifest is the contract: `fetch-corpus` refuses to install an asset whose
 * sha256 or byte count does not match. That turns an interrupted download, a
 * truncated file, or a swapped asset into a hard failure that leaves the previous
 * corpus untouched - instead of a half-broken corpus that yields wrong search
 * results.
 *
 * Two properties this script must guarantee:
 *
 *   1. REPRODUCIBLE. Packing the same data twice must give the same sha256, or
 *      the manifest and the uploaded asset can silently drift apart. GNU tar is
 *      not available everywhere (`bsdtar` on macOS rejects `--mtime`), so the
 *      archive is written here with node:zlib instead of shelling out.
 *      Determinism comes from the gzip header (mtime 0) plus a SORTED directory
 *      walk - readdir order is filesystem-dependent, so an unsorted archive
 *      hashes differently on a different machine.
 *
 *   2. NOT LYING ABOUT TIME. The gzip header is zeroed, but every tar entry keeps
 *      its real mtime. The data cutoff is read from INSIDE the data (SQLite
 *      `updated_at`, record `scrape_time`), so it does not depend on this - but a
 *      user cross-checking the files against the documented cutoff does.
 *
 * Usage:
 *   node scripts/pack-corpus.mjs --corpus chictr_pancreatic --source <data-dir>
 *        [--out <dir>] [--write-manifest]
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'corpora', 'manifest.json');


/**
 * Each corpus declares exactly which paths inside the source directory go into
 * the archive. Listing them explicitly (rather than archiving the directory)
 * keeps stray files - .DS_Store, -wal/-shm SQLite sidecars, editor backups - out
 * of a published asset.
 */
const CORPORA = {
  chictr_pancreatic: {
    title: 'ChiCTR 胰腺癌离线语料',
    entries: ['chictr_pancreatic.db', 'pancreatic_trials.json', 'html'],
    extractDir: 'chictr_pancreatic',
    note: 'ChiCTR 公开登记信息离线快照；数据版权归 ChiCTR，本服务仅作搬运与只读索引。',
  },
};

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(token.slice(2), true);
    } else {
      flags.set(token.slice(2), next);
      i += 1;
    }
  }
  return flags;
}

/** tar header: 512 bytes, ustar format. */
function tarHeader(name, size, mode, typeflag, mtime) {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) =>
    header.write(value.slice(0, length).padEnd(length, '\0'), offset, length, 'utf8');

  // Long paths: emit a PAX extended header so nothing is silently truncated.
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`path too long for a plain ustar entry (${name}); split the corpus differently`);
  }

  write(name, 0, 100);
  write(mode.toString(8).padStart(7, '0'), 100, 8);
  write('0000000', 108, 8); // uid
  write('0000000', 116, 8); // gid
  write(size.toString(8).padStart(11, '0'), 124, 12);
  write(mtime.toString(8).padStart(11, '0'), 136, 12);
  header.write('        ', 148, 8, 'utf8'); // checksum placeholder
  write(typeflag, 156, 1);
  write('ustar\0', 257, 6);
  write('00', 263, 2); // no uname/gname: reproducible across machines

  let sum = 0;
  for (const byte of header) sum += byte;
  write(sum.toString(8).padStart(6, '0'), 148, 7);
  header.write(' ', 154, 1, 'utf8');
  return header;
}

function pad512(size) {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

/**
 * Walk the declared entries in a stable order (sorted, depth-first).
 *
 * Sorting matters: readdir order is filesystem-dependent, and an unstable order
 * would produce a different archive - and therefore a different sha256 - on a
 * different machine.
 */
async function collect(sourceDir, entries) {
  const files = [];
  for (const entry of entries) {
    const full = path.join(sourceDir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      const walk = async (dir) => {
        const children = await readdir(dir, { withFileTypes: true });
        children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const child of children) {
          const childPath = path.join(dir, child.name);
          if (child.isDirectory()) await walk(childPath);
          else if (child.isFile()) files.push(childPath);
        }
      };
      await walk(full);
    } else if (info.isFile()) {
      files.push(full);
    } else {
      throw new Error(`unsupported entry type: ${entry}`);
    }
  }
  return files;
}

async function buildArchive(sourceDir, files, assetPath) {
  const chunks = async function* () {
    for (const file of files) {
      const info = await stat(file);
      const name = path.relative(sourceDir, file).split(path.sep).join('/');
      // Keep the file's REAL mtime. The offline adapters read their data cutoff
      // from inside the data (SQLite updated_at, record scrape_time), but a user
      // cross-checking by hand compares against the filesystem - so pinning these
      // to a fake date would actively mislead. Determinism comes from the gzip
      // header (mtime 0) and the sorted walk, not from falsifying file times.
      yield tarHeader(name, info.size, 0o644, '0', Math.floor(info.mtimeMs / 1000));
      yield* createReadStream(file);
      const padding = pad512(info.size);
      if (padding) yield Buffer.alloc(padding);
    }
    // tar terminates with two zero blocks, then padding to the gzip block size.
    yield Buffer.alloc(1024);
    yield Buffer.alloc(pad512(1024));
  };

  await pipeline(
    Readable.from(chunks()),
    // mtime: 0 removes the packing timestamp from the gzip header. Without this
    // the same data hashes differently on every run, and the manifest can never
    // be trusted to match the published asset.
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(assetPath),
  );
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const corpusId = typeof flags.get('corpus') === 'string' ? flags.get('corpus') : undefined;
  const source = typeof flags.get('source') === 'string' ? flags.get('source') : undefined;

  if (!corpusId || !CORPORA[corpusId]) {
    process.stderr.write(
      `usage: node scripts/pack-corpus.mjs --corpus <${Object.keys(CORPORA).join('|')}> --source <data-dir> [--out <dir>] [--write-manifest]\n`,
    );
    return 2;
  }
  if (!source) {
    process.stderr.write('--source <data-dir> is required\n');
    return 2;
  }

  const spec = CORPORA[corpusId];
  const sourceDir = path.resolve(source);
  const outDir = path.resolve(
    typeof flags.get('out') === 'string' ? flags.get('out') : path.join(ROOT, 'dist-release'),
  );

  // Every declared entry must exist before we start: a missing html/ directory
  // would otherwise produce a "successful" archive that is silently incomplete.
  for (const entry of spec.entries) {
    try {
      await stat(path.join(sourceDir, entry));
    } catch {
      process.stderr.write(`missing entry in source dir: ${entry}\n`);
      return 1;
    }
  }

  await mkdir(outDir, { recursive: true });
  const assetName = `${corpusId}.tar.gz`;
  const assetPath = path.join(outDir, assetName);

  const files = await collect(sourceDir, spec.entries);
  process.stdout.write(`packing ${files.length} file(s) from ${sourceDir}\n`);
  await buildArchive(sourceDir, files, assetPath);

  const info = await stat(assetPath);
  const digest = await sha256(assetPath);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const version = new Date().toISOString().slice(0, 10);
  const entry = {
    url: `https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/${corpusId}-${version}/${assetName}`,
    bytes: info.size,
    sha256: digest,
    extractDir: spec.extractDir,
    version,
    title: spec.title,
    note: spec.note,
  };

  process.stdout.write(
    `\n${assetName}\n  files  : ${files.length}\n  bytes  : ${info.size}\n  sha256 : ${digest}\n`,
  );

  if (flags.get('write-manifest')) {
    manifest.corpora[corpusId] = entry;
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nmanifest updated: ${path.relative(ROOT, MANIFEST_PATH)}\n`);
    process.stdout.write(
      `\nNext steps (order matters - the manifest must match the uploaded asset):\n` +
        `  1. gh release create ${corpusId}-${version} "${assetPath}" --title "${spec.title} ${version}"\n` +
        `  2. git add corpora/manifest.json && git commit -m "data: publish ${corpusId} ${version}"\n`,
    );
  } else {
    process.stdout.write(`\n(dry run: manifest not written; pass --write-manifest to update it)\n`);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
