import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

test('normalizer: record identity is <sourceId>:<sourceRecordId>', async () => {
  const { makeRecordId, parseRecordId } = await load('core/normalizer.js');
  assert.equal(makeRecordId('ictrp', 'NCT123'), 'ictrp:NCT123');
  const parsed = parseRecordId('ictrp:NCT123');
  assert.equal(parsed.sourceId, 'ictrp');
  assert.equal(parsed.sourceRecordId, 'NCT123');
});

test('cookie: a cURL command yields a cookie, a challenge page is detected', async () => {
  const { extractCookieFromCurl, maskCookie, hasOnlyAnonymousTickets, isChallengeHtml } = await load('cli/cookie.js');

  // Both forms that browsers emit must parse; the extracted value is rebuilt
  // from name=value pairs so surrounding shell quoting is never carried over.
  const quoted = `curl 'https://x/y' -b 'a=1; b=2' -H 'User-Agent: x'`;
  assert.equal(extractCookieFromCurl(quoted), 'a=1; b=2');
  const headerForm = `curl 'https://x/y' -H 'Cookie: a=1; b=2'`;
  assert.equal(extractCookieFromCurl(headerForm), 'a=1; b=2');
  assert.equal(extractCookieFromCurl('curl https://x/y'), undefined, 'no cookie must stay undefined, not empty');

  // A masked cookie shows field names and a length, never the full value.
  const masked = maskCookie('FSSBBIl1UgzbN7N80S=abcdefghijklmnop');
  assert.ok(!masked.includes('abcdefghijklmnop'), 'masking must not reveal the value');
  assert.ok(masked.includes('FSSBBIl1UgzbN7N80S'));

  assert.equal(hasOnlyAnonymousTickets('FSSBBIl1UgzbN7N80S=x'), true);
  assert.equal(hasOnlyAnonymousTickets('JSESSIONID=x'), false);

  // Challenge pages must be recognised: mistaking one for "no results" would
  // report absence of a trial that actually exists.
  assert.equal(isChallengeHtml('<html><head><meta a><meta b></head><body></body></html>'), true);
  assert.equal(isChallengeHtml('<html><body><table id="searchTable"></table></body></html>'), false);
});

test('cookie: the cookie env file is parsed without ever leaking or inventing secrets', async () => {
  const { loadConfig } = await load('core/config.js');
  const files = {
    '/cfg/cookie.env': [
      '# comment',
      "export CHINADRUGTRIALS_COOKIE='a=1; b=2'",
      'CDT_COOKIE="quoted"',
      'GARBAGE LINE',
      '',
    ].join('\n'),
  };
  const loaded = await loadConfig(
    { configDir: '/cfg' },
    { env: {}, readFile: async (file) => { if (files[file]) return files[file]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
  );
  assert.equal(loaded.secrets.get('CHINADRUGTRIALS_COOKIE'), 'a=1; b=2');
  assert.equal(loaded.secrets.get('CDT_COOKIE'), 'quoted');
  assert.equal(loaded.secrets.has('CHINADRUGTRIALS_COOKIE'), true);

  // A real environment variable must win over the file, so an explicit export
  // always overrides whatever configure last wrote.
  const overridden = await loadConfig(
    { configDir: '/cfg' },
    { env: { CHINADRUGTRIALS_COOKIE: 'from-env' }, readFile: async (file) => { if (files[file]) return files[file]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } },
  );
  assert.equal(overridden.secrets.get('CHINADRUGTRIALS_COOKIE'), 'from-env');

  // A missing file means "not configured", never a fabricated value.
  const absent = await loadConfig({ configDir: '/nowhere' }, { env: {}, readFile: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } });
  assert.equal(absent.secrets.has('CHINADRUGTRIALS_COOKIE'), false);
});

test('normalizer: registry numbers are normalized but never fuzzy-matched', async () => {
  const { normalizeRegistryNumber } = await load('core/normalizer.js');
  assert.equal(normalizeRegistryNumber('nct-03558945'), 'NCT03558945');
  assert.equal(normalizeRegistryNumber('ChiCTR 1800020401'), 'CHICTR1800020401');
});

test('normalizer: a record without a source record id fails loudly', async () => {
  const { normalizeRecord } = await load('core/normalizer.js');
  assert.throws(
    () => normalizeRecord({ title: 'x' }, { id: 'ictrp', label: 'ICTRP', maxResults: 10 }, {}),
    (error) => error.reasonCode === 'MISSING_SOURCE_RECORD_ID',
  );
});


/** Builds a minimal but structurally valid CanonicalTrialRecord. */
function canonical(sourceId, sourceRecordId, registries) {
  return {
    recordId: `${sourceId}:${sourceRecordId}`,
    source: { id: sourceId, label: sourceId, sourceRecordId },
    registryNumbers: registries.map(([registry, value, primary]) => ({ registry, value, primary })),
    title: 't',
    conditionOrDisease: [],
    interventions: [],
    phase: [],
    sponsorOrInstitution: [],
    countries: [],
    provenance: { rawEvidenceRefs: [], piiLevel: 'none_known' },
  };
}

test('merger: records merge only on reliable registry identity', async () => {
  const { mergeRecords } = await load('core/merger.js');
  const result = mergeRecords([
    canonical('a', '1', [['NCT', 'NCT1', true]]),
    canonical('b', '1', [['NCT', 'NCT1', true]]),
  ]);
  assert.equal(result.records.length, 1, 'same reliable registry id must merge');
  assert.equal(result.records[0].mergedFrom.length, 2);
});

test('merger: identical titles with different registries do NOT merge', async () => {
  const { mergeRecords } = await load('core/merger.js');
  const result = mergeRecords([
    canonical('a', '1', [['NCT', 'NCT1', true]]),
    canonical('b', '1', [['CHICTR', 'CHICTR1', true]]),
  ]);
  assert.equal(result.records.length, 2, 'title similarity must never merge records');
  assert.deepEqual(result.overlaps, []);
});

test('registry: source selection cannot be extended by a caller', async () => {
  const { resolveRequestedSources } = await load('core/registry.js');
  const rejected = resolveRequestedSources(['not_a_source']);
  assert.deepEqual(rejected.rejected, ['not_a_source'], 'unknown sources must be rejected, not resolved');
  assert.deepEqual(rejected.sources, [], 'a rejected source must not become a queryable one');
  const resolved = resolveRequestedSources(['ictrp']);
  assert.deepEqual(resolved.sources.map((d) => d.id), ['ictrp']);
});

test('registry: ictrp is flagged as a lower-bound source', async () => {
  const { getDescriptor } = await load('core/registry.js');
  assert.equal(getDescriptor('ictrp').isLowerBound, true);
});

test('mcp-client: an upstream error envelope is never zero results', async () => {
  const { unwrapToolContent } = await load('core/mcp-client.js');
  const raw = {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code: 'UNKNOWN_ERROR', message: "browserType.launch: Executable doesn't exist", retryable: true }) }],
  };
  assert.throws(
    () => unwrapToolContent(raw, 'search_trials'),
    (error) => error.state === 'NEEDS_SETUP' && error.reasonCode === 'UPSTREAM_BROWSER_MISSING' && /playwright/i.test(error.fixHint),
  );
});

test('mcp-client: unparseable envelope fails instead of returning nothing', async () => {
  const { unwrapToolContent } = await load('core/mcp-client.js');
  assert.throws(
    () => unwrapToolContent({ content: [{ type: 'text', text: 'not json at all' }] }, 'search_studies'),
    (error) => error.reasonCode === 'UPSTREAM_ENVELOPE_UNRECOGNISED',
  );
});

test('logger: secret-looking fields are redacted', async () => {
  const { redactValue } = await load('core/logger.js');
  const redacted = redactValue({ cookie: 'SECRETVALUE', token: 'abc', nested: { authorization: 'Bearer x' } }, ['SECRETVALUE'], 0);
  const text = JSON.stringify(redacted);
  assert.ok(!text.includes('SECRETVALUE'), 'secret value must never be serialized');
  assert.ok(!text.includes('Bearer x'));
});

test('tools: unknown source ids are rejected', async () => {
  const { TOOL_HANDLERS } = await load('tools/handlers.js');
  const outcome = await TOOL_HANDLERS['get_source_status']({ sourceIds: ['evil_source'] }, {});
  assert.equal(outcome.error?.code, 'UNKNOWN_SOURCE');
});

test('tools: record handle parsing rejects malformed ids', async () => {
  const { parseRecordHandle } = await load('tools/handlers.js');
  assert.throws(() => parseRecordHandle('nocolon'), (e) => e.reasonCode === 'INVALID_RECORD_ID');
  assert.throws(() => parseRecordHandle('nope:1'), (e) => e.reasonCode === 'UNKNOWN_SOURCE');
  assert.deepEqual(parseRecordHandle('ictrp:NCT1'), { sourceId: 'ictrp', sourceRecordId: 'NCT1' });
});

test('chictr corpus: a Node without node:sqlite degrades instead of crashing', async () => {
  // The regression this guards is real and was caught only by CI: a top-level
  // `import { DatabaseSync } from 'node:sqlite'` kills the whole process on
  // Node 20 with ERR_UNKNOWN_BUILTIN_MODULE, taking all six sources down even
  // though only the corpus adapter needs SQLite. Importing the module must
  // therefore be free of that dependency, and the failure must surface as an
  // ordinary per-source NEEDS_SETUP conclusion carrying a version to upgrade to.
  const mod = await load('adapters/chictr-pancreatic.js');
  assert.equal(typeof mod.ChictrPancreaticAdapter, 'function');
  assert.ok(mod.NODE_SQLITE_MIN_VERSION, 'the supported floor must be exported');
  assert.match(mod.NODE_SQLITE_MIN_VERSION, /^\d+\.\d+\.\d+$/);

  // A missing/unallowlisted corpus is reported, never thrown out of the process.
  const adapter = new mod.ChictrPancreaticAdapter();
  const status = await adapter.getStatus({ paths: { chictrCorpus: undefined, evidenceRoots: ['/tmp'] } });
  assert.equal(status.state, 'NEEDS_SETUP');
  assert.equal(status.sourceId, 'chictr_pancreatic_archive');
  assert.ok(status.fixHint, 'a fix hint is required so the failure is actionable');
});

test('cutoff: the archive cutoff is derived from evidence, never hardcoded', async () => {
  const { assessCutoff, formatCutoff, latestTimestamp, futureCutoffWarning, offsetMinutesOf } = await load('core/cutoff.js');

  // The cutoff is the newest usable timestamp; a malformed one must be ignored
  // rather than silently treated as "now", which would make stale data look live.
  assert.equal(latestTimestamp(['2026-01-01T00:00:00Z', 'not-a-date', '2026-03-01T00:00:00Z']), '2026-03-01T00:00:00Z');
  assert.equal(latestTimestamp(['nonsense']), undefined);
  assert.equal(latestTimestamp([]), undefined);

  // Record-level times outrank declared metadata: a summary may claim a scrape
  // time the records themselves do not support (the shipped packages do).
  const assessment = assessCutoff({
    recordTimestamps: ['2026-08-14T00:00:00Z', '2026-09-28T00:00:00Z'],
    packageTimestamps: ['2026-09-29T00:00:00Z'],
    cutoffSource: 'test',
  });
  assert.equal(assessment.cutoff, '2026-09-28T00:00:00Z');
  assert.equal(assessment.captureFrom, '2026-08-14T00:00:00Z');
  assert.ok(assessment.warning, 'a multi-week capture window must be reported, not smoothed over');

  // A single uniform snapshot reports no spread and needs no warning.
  const uniform = assessCutoff({
    recordTimestamps: ['2026-09-28T00:00:00Z', '2026-09-28T06:00:00Z'],
    cutoffSource: 'test',
  });
  assert.equal(uniform.spread, false);
  assert.equal(uniform.warning, undefined);

  // Dates render as a plain date IN THE TIMESTAMP'S OWN OFFSET. This matters:
  // these corpora are captured at +08:00, and slicing UTC would report the
  // previous day for anything captured before 08:00 local - understating how
  // current the snapshot is.
  assert.equal(formatCutoff('2026-09-28T07:59:24.275394+08:00'), '2026-09-28');
  assert.equal(formatCutoff('2026-10-04T22:31:31+08:00'), '2026-10-04');
  assert.equal(formatCutoff('2026-09-28T07:59:24-05:00'), '2026-09-28');
  assert.equal(formatCutoff('2026-09-28T12:00:00Z'), '2026-09-28');
  // A timestamp with no offset must NOT be forced through a timezone it never
  // claimed. ECMAScript parses a `T` form as LOCAL time, so the date rendered is
  // the one the producer wrote, whatever the host timezone is - asserting a
  // fixed string here is what broke CI, where the runner is UTC and macOS is not.
  assert.equal(formatCutoff('2026-09-28T07:59:24.275394'), '2026-09-28');
  assert.equal(formatCutoff('2026-09-28T23:30:00'), '2026-09-28');
  // The rendering must be pure arithmetic, never an ICU time-zone lookup:
  // `Etc/GMT-8` resolved locally but not in CI, and `UTC+08:00` is rejected
  // everywhere. This asserts the offset maths directly so a future refactor back
  // to Intl fails here rather than only on Linux.
  assert.equal(offsetMinutesOf('2026-09-28T07:59:24.275394+08:00'), 480);
  assert.equal(offsetMinutesOf('2026-09-28T07:59:24-05:00'), -300);
  assert.equal(offsetMinutesOf('2026-09-28T12:00:00Z'), 0);
  assert.equal(offsetMinutesOf('2026-09-28T07:59:24.275394'), undefined);
  // Offset-bearing stamps must render identically regardless of the host zone:
  // that is the property CI actually broke, and it is what makes the number
  // comparable across machines.
  assert.equal(formatCutoff('2026-09-28T23:30:00-05:00'), '2026-09-28');
  assert.equal(formatCutoff('2026-09-29T00:30:00+05:30'), '2026-09-29');
  // A half-hour offset must land on the right date too.
  assert.equal(formatCutoff('2026-01-01T00:30:00+05:30'), '2026-01-01');

  // Unparseable input is shown raw, never invented or silently dropped.
  assert.equal(formatCutoff(undefined), '未知');
  assert.equal(formatCutoff('nonsense'), 'nonsense');

  // A package claiming to be scraped in the future is untrustworthy.
  const future = futureCutoffWarning('2099-01-01T00:00:00Z', new Date('2026-10-05T00:00:00Z'), 86_400_000);
  assert.ok(future && future.includes('晚于当前时间'));
  assert.equal(futureCutoffWarning('2026-10-04T00:00:00Z', new Date('2026-10-05T00:00:00Z'), 86_400_000), undefined);
});

test('sources: every offline archive declares how it is refreshed', async () => {
  const registry = await load('core/registry.js');
  const chictr = await load('adapters/chictr-pancreatic.js');
  const xyb = await load('adapters/xyb-archive.js');

  // Offline snapshots are community-maintained; each must state its update path,
  // so a reader who hits the cutoff has somewhere to go.
  assert.ok(chictr.CHICTR_CORPUS_UPDATE_HINT.includes('社区'));
  assert.ok(xyb.XYB_ARCHIVE_UPDATE_HINT.includes('社区'));
  for (const hint of [chictr.CHICTR_CORPUS_UPDATE_HINT, xyb.XYB_ARCHIVE_UPDATE_HINT]) {
    assert.ok(hint.includes('configure'), 'the hint must name the concrete command');
    assert.ok(hint.includes('非官方'), 'the hint must not imply official real-time data');
  }

  // The scope text must admit the cutoff, so a zero-result answer cannot be read
  // as "this trial does not exist".
  for (const id of ['chictr_pancreatic_archive', 'xyb_chinadrugtrials_archive']) {
    const descriptor = registry.getDescriptor(id);
    assert.equal(descriptor.freshness, 'offline_archive');
    assert.ok(descriptor.scope.includes('数据截止日'), `${id} scope must mention the cutoff`);
    assert.ok(descriptor.zeroResultMeaning.includes('数据截止日'), `${id} zero-result meaning must mention the cutoff`);
  }
});

test('docs: the status table documents exactly the states the code can return', async () => {
  // The status table is the contract a caller reads before deciding what a
  // result means. A state added to the code but missing from the docs (or a
  // documented state that no longer exists) is a silent lie about whether the
  // service looked, so the two are pinned together here.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const { SOURCE_STATES } = await load('core/types.js');
  assert.equal(SOURCE_STATES.length, 10, 'the terminal-state set changed; update both READMEs');

  for (const file of ['README.md', 'README.zh-CN.md']) {
    const text = await readFile(path.join(ROOT, file), 'utf8');
    const heading = file.endsWith('zh-CN.md') ? '## 状态码解读' : '## Reading the status codes';
    const start = text.indexOf(heading);
    assert.ok(start >= 0, `${file} must have a status-code section`);
    const section = text.slice(start, text.indexOf('\n## ', start + 1));

    for (const state of SOURCE_STATES) {
      assert.ok(section.includes(`\`${state}\``), `${file} must document ${state}`);
    }
    // Only SUCCESS and NO_RESULTS mean the source was queried; the prose must
    // say so, because that is the distinction the whole table exists for.
    assert.ok(
      section.includes('SUCCESS') && section.includes('NO_RESULTS'),
      `${file} must state which states mean "queried"`,
    );
  }
});

test('cli: a symlinked entry still runs the program', async () => {
  // `npm install -g` exposes the command as a symlink in the global bin dir, so
  // process.argv[1] is the LINK path while import.meta.url is already resolved.
  // Comparing them literally made the CLI a silent no-op that exited 0 after
  // installation - invisible when running the real path from the source tree.
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, symlinkSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ROOT, DIST } = await import('./helpers.mjs');

  const entry = path.join(DIST, 'cli', 'main.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'utcd-symlink-'));
  const link = path.join(dir, 'unified-trial-mcp');
  symlinkSync(entry, link);

  const out = execFileSync(link, ['help'], { encoding: 'utf8' });
  assert.ok(out.includes('unified-trial-mcp'), 'a symlinked entry must still print usage');
  assert.ok(out.length > 50, 'the CLI must do real work, not exit silently');
  assert.ok(ROOT.length > 0);
});

test('corpus: a checksum mismatch is fatal and leaves the installed corpus untouched', async () => {
  // The whole point of ADR-008's verification step: a bad download must never
  // replace working data. A truncated file, a swapped asset or a corrupted
  // transfer all have to end as "previous corpus still intact", not as a
  // half-written directory that silently returns wrong search results.
  const { fetchCorpus, CorpusError } = await load('cli/corpus.js');
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const root = await mkdtemp(path.join(os.tmpdir(), 'utcd-corpus-'));
  const destDir = path.join(root, 'corpora');
  const corpusDir = path.join(destDir, 'chictr_pancreatic');
  await mkdir(corpusDir, { recursive: true });
  await writeFile(path.join(corpusDir, 'chictr_pancreatic.db'), 'ORIGINAL DATA');

  const entry = {
    url: 'https://example.invalid/corpus.tar.gz',
    bytes: 4,
    sha256: 'a'.repeat(64),
    extractDir: 'chictr_pancreatic',
    version: '2026-01-01',
    title: 'test corpus',
  };

  let tarCalled = false;
  await assert.rejects(
    () =>
      fetchCorpus(
        { corpusId: 'chictr_pancreatic', destDir, apply: true },
        {
          readManifest: async () => ({ corpora: { chictr_pancreatic: entry } }),
          // Every download "succeeds" with the wrong content.
          fetchImpl: async () =>
            new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
          runTar: async () => {
            tarCalled = true;
          },
        },
      ),
    (error) => {
      assert.ok(error instanceof CorpusError, `expected CorpusError, got ${error}`);
      assert.equal(error.reasonCode, 'SHA256_MISMATCH');
      // The message must say what was preserved, not just that it failed.
      assert.match(error.fixHint ?? '', /保留原有数据/);
      return true;
    },
  );

  assert.equal(tarCalled, false, 'nothing may be extracted before the checksum passes');
  assert.equal(
    await readFile(path.join(corpusDir, 'chictr_pancreatic.db'), 'utf8'),
    'ORIGINAL DATA',
    'the installed corpus must survive a failed download',
  );
  const leftover = await (await import('node:fs/promises')).readdir(destDir);
  assert.deepEqual(leftover, ['chictr_pancreatic'], 'no staging directory may be left behind');
  await rm(root, { recursive: true, force: true });
});

test('corpus: a size mismatch is caught before hashing', async () => {
  const { fetchCorpus } = await load('cli/corpus.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const destDir = await mkdtemp(path.join(os.tmpdir(), 'utcd-corpus-size-'));
  let hashed = false;
  await assert.rejects(
    () =>
      fetchCorpus(
        { corpusId: 'chictr_pancreatic', destDir, apply: true },
        {
          readManifest: async () => ({
            corpora: {
              chictr_pancreatic: {
                url: 'https://example.invalid/c.tar.gz',
                bytes: 999,
                sha256: 'b'.repeat(64),
                extractDir: 'chictr_pancreatic',
                version: '1',
                title: 't',
              },
            },
          }),
          // A truncated transfer: fewer bytes than the manifest promises.
          fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
          sha256File: async () => {
            hashed = true;
            return 'b'.repeat(64);
          },
        },
      ),
    (error) => {
      assert.equal(error.reasonCode, 'SIZE_MISMATCH');
      return true;
    },
  );
  assert.equal(hashed, false, 'a truncated download should be rejected without hashing');
  await rm(destDir, { recursive: true, force: true });
});

test('corpus: a dry run touches neither the network nor the disk', async () => {
  // bootstrap defaults to a dry run; fetch-corpus must behave the same way, or
  // "preview what will happen" becomes a 25 MB surprise.
  const { fetchCorpus } = await load('cli/corpus.js');
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const destDir = await mkdtemp(path.join(os.tmpdir(), 'utcd-corpus-dry-'));
  let fetched = false;
  const result = await fetchCorpus(
    { corpusId: 'chictr_pancreatic', destDir, apply: false },
    {
      readManifest: async () => ({
        corpora: {
          chictr_pancreatic: {
            url: 'https://example.invalid/c.tar.gz',
            bytes: 123,
            sha256: 'c'.repeat(64),
            extractDir: 'chictr_pancreatic',
            version: '1',
            title: 't',
          },
        },
      }),
      fetchImpl: async () => {
        fetched = true;
        return new Response('nope');
      },
    },
  );

  assert.equal(fetched, false, 'a dry run must not download anything');
  assert.equal(result.applied, false);
  // The preview still has to show what WOULD be fetched, or it is useless.
  assert.equal(result.bytes, 123);
  assert.equal(result.sha256, 'c'.repeat(64));
  assert.match(result.url, /^https:\/\//);
  assert.deepEqual(await readdir(destDir), [], 'a dry run must not create files');
  await rm(destDir, { recursive: true, force: true });
});

test('corpus: a corpus missing from the manifest fails with a usable hint', async () => {
  const { fetchCorpus } = await load('cli/corpus.js');
  await assert.rejects(
    () => fetchCorpus({ corpusId: 'nope', apply: false }, { readManifest: async () => ({ corpora: {} }) }),
    (error) => {
      assert.equal(error.reasonCode, 'CORPUS_NOT_IN_MANIFEST');
      assert.match(error.fixHint, /pack-corpus\.mjs/);
      return true;
    },
  );
});

test('corpus: the manifest and the packer agree on what a corpus is', async () => {
  // The manifest is generated by scripts/pack-corpus.mjs and consumed by
  // src/cli/corpus.ts. If they disagree about the corpus id or the extracted
  // directory layout, `configure --chictr-corpus` points at a path that will not
  // exist - a failure that only surfaces on a user's first cold start.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');

  const packer = await readFile(path.join(ROOT, 'scripts', 'pack-corpus.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'corpora', 'manifest.json'), 'utf8'));

  for (const corpusId of Object.keys(manifest.corpora)) {
    assert.ok(
      packer.includes(`${corpusId}: {`),
      `pack-corpus.mjs must declare the corpus "${corpusId}" that the manifest publishes`,
    );
  }

  const entry = manifest.corpora.chictr_pancreatic;
  if (entry) {
    // The adapter opens <corpusDir>/chictr_pancreatic.db; corpus.ts builds that
    // path from extractDir, so a mismatch installs a corpus nothing can read.
    assert.equal(entry.extractDir, 'chictr_pancreatic');
    assert.ok(entry.bytes > 0 && /^[0-9a-f]{64}$/.test(entry.sha256), 'a published entry needs a real digest');
    assert.match(entry.url, /^https:\/\/github\.com\//);
    // A url that does not carry the filename makes a 404 look like a network fault.
    assert.ok(entry.url.endsWith('chictr_pancreatic.tar.gz'), 'the release asset name must match');
  }
});
