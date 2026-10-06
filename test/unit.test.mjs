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

test('config: the work directory follows the config directory, not the home directory', async () => {
  // Redirecting the config directory moved the config file and the cookie, but
  // `bootstrap` still created `~/.unified-trial-mcp/work` in the user's home:
  // workDir defaulted off `defaultConfigDir()` (the homedir) instead of the
  // configDir in force. On a shared or containerised host that writes outside
  // the directory the operator pointed the service at.
  const { loadConfig } = await load('core/config.js');
  const missing = async () => {
    const e = new Error('ENOENT');
    e.code = 'ENOENT';
    throw e;
  };

  // Via the environment, which is how a container or CI points it elsewhere.
  const viaEnv = await loadConfig({}, { env: { UNIFIED_TRIAL_CONFIG_DIR: '/srv/trials-cfg' }, readFile: missing });
  assert.equal(viaEnv.paths.configDir, '/srv/trials-cfg');
  assert.equal(
    viaEnv.paths.workDir,
    '/srv/trials-cfg/work',
    `the work directory must live under the config directory in force, got: ${viaEnv.paths.workDir}`,
  );

  // Via the flag. An explicit --work-dir still wins over both.
  const viaFlag = await loadConfig({ configDir: '/srv/other-cfg' }, { env: {}, readFile: missing });
  assert.equal(viaFlag.paths.workDir, '/srv/other-cfg/work');
  const explicit = await loadConfig(
    { configDir: '/srv/other-cfg', workDir: '/scratch/work' },
    { env: {}, readFile: missing },
  );
  assert.equal(explicit.paths.workDir, '/scratch/work');
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

test('logger: a literal cookie is scrubbed out of prose, not just out of a named field', async () => {
  // Key-name redaction only catches a secret that arrives under a recognisable
  // FIELD name (`cookie: ...`). A cookie that reaches a log line inside a
  // sentence - an upstream error string, a transport message that quotes the
  // request - has no key to match on, so the scrubber has to be told the
  // literal value. Behaviourally, two things must both hold, and this test
  // covers the first: loadConfig must actually collect the values, and the
  // logger must remove them once given them.
  //
  // The second half - that buildRuntime hands them over - is asserted by
  // `logger: the cli wires the literal secrets into its logger` below, because
  // calling createLogger directly here would keep passing after that wiring was
  // deleted, and the wiring is the entire fix.
  const { loadConfig } = await load('core/config.js');
  const { createLogger } = await load('core/logger.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const COOKIE = 'SESSIONCOOKIE-c0ffee-9284';
  const root = await mkdtemp(path.join(os.tmpdir(), 'ut-secret-wire-'));
  try {
    const loaded = await loadConfig(
      { configDir: root },
      {
        env: { UNIFIED_TRIAL_CONFIG_DIR: root, CHINADRUGTRIALS_COOKIE: COOKIE },
        readFile: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      },
    );
    assert.ok(
      loaded.secretValues.includes(COOKIE),
      `loadConfig must expose the literal secret, got ${JSON.stringify(loaded.secretValues)}`,
    );

    const lines = [];
    const logger = createLogger({ level: 'info', secretValues: loaded.secretValues, sink: (l) => lines.push(l) });
    // The message shapes a real leak takes: the value inside a sentence, and
    // inside a transport-style message that quotes the request headers.
    logger.warn('上游返回了意外内容', {
      detail: `invalid session, cookie=${COOKIE}, retrying`,
      transport: `request failed, headers: { cookie: '${COOKIE}' }`,
    });
    logger.error(`ChinaDrugTrials 拒绝访问（cookie ${COOKIE} 已失效）`);

    const output = lines.join('\n');
    assert.equal(lines.length, 2, 'both lines must be emitted');
    assert.ok(!output.includes(COOKIE), `the literal cookie must never reach the sink, got: ${output}`);
    assert.ok(output.includes('[REDACTED]'), 'the scrub must be visible, not a silent drop');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('logger: the cli wires the literal secrets into its logger', async () => {
  // The wiring half of the fix above. `buildRuntime` used to call
  // `createLogger({ level: 'info' })` with no `secretValues`, so the scrubber
  // had key names only and a cookie in prose went out verbatim. A test that
  // calls createLogger itself cannot see that regression, so this one reads the
  // real source: the call site must pass `loaded.secretValues`.
  const { DIST } = await import('./helpers.mjs');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const source = await readFile(path.join(DIST, 'cli', 'main.js'), 'utf8');
  assert.match(
    source,
    /createLogger\(\{[^}]*secretValues:\s*loaded\.secretValues/,
    'the cli must hand the literal secret values to the logger, or a cookie interpolated into a message is logged in the clear',
  );
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
    basis: 'upstream_public',
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
                basis: 'upstream_public',
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

test('bootstrap: --apply mounts every corpus it installs', async () => {
  // Installing without mounting left the user with a downloaded corpus that
  // `doctor` still reported as unconfigured, so "bootstrap --apply finished"
  // did not mean the source was usable. This pins the two halves together.
  //
  // The download is served from a local `file://` tarball rather than GitHub:
  // the point here is install-and-mount, and letting the real Release decide
  // whether this test passes made it fail for a reason it does not assert
  // (a 10s connect timeout to github.com:443, retried three times).
  const { runBootstrap } = await load('cli/bootstrap.js');
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const root = await mkdtemp(path.join(os.tmpdir(), 'utcd-boot-mount-'));
  const configDir = path.join(root, 'config');

  try {
    // A real (tiny) corpus package: one readable SQLite file at the archive
    // root, which is the layout `chictr_pancreatic` installs to. It has to be a
    // genuine database with a `trials` table, because the install verifies it
    // can be read before reporting success - a text file would (correctly) be
    // rejected with "file is not a database".
    const payload = path.join(root, 'payload');
    await mkdir(payload, { recursive: true });
    const dbFile = path.join(payload, 'chictr_pancreatic.db');
    const { DatabaseSync } = await import('node:sqlite');
    const fixture = new DatabaseSync(dbFile);
    try {
      fixture.exec('CREATE TABLE trials (project_id TEXT PRIMARY KEY)');
      fixture.exec("INSERT INTO trials (project_id) VALUES ('fixture-1')");
    } finally {
      fixture.close();
    }
    const archive = path.join(root, 'chictr_pancreatic.tar.gz');
    await run('tar', ['-czf', archive, '-C', payload, 'chictr_pancreatic.db']);
    const bytes = (await import('node:fs')).statSync(archive).size;
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');

    const outcome = await runBootstrap({
      paths: {
        configDir,
        workDir: path.join(root, 'work'),
        chictrCorpus: undefined,
        xybArchive: undefined,
        chinadrugtrialsArchive: undefined,
        ictrpBundle: undefined,
        ctvDatabase: undefined,
        ctvMcpServer: undefined,
        chictrMcpServer: undefined,
        evidenceRoots: [],
      },
      sourceIds: ['chictr_pancreatic_archive'],
      apply: true,
      dryRun: false,
      withCtvIndex: false,
      maxPages: 1,
      corpusDeps: {
        readManifest: async () => ({
          corpora: {
            chictr_pancreatic: {
              url: pathToFileURL(archive).href,
              bytes,
              sha256,
              extractDir: 'chictr_pancreatic',
              version: '1',
              title: 't',
              basis: 'upstream_public',
            },
          },
        }),
        // Any network use here means the test stopped being hermetic.
        fetchImpl: async () => {
          throw new Error('the mount test must not touch the network');
        },
      },
    });

    const step = outcome.steps.find((entry) => entry.sourceId === 'chictr_pancreatic_archive');
    assert.ok(step, 'bootstrap must report the offline corpus it handles');
    assert.ok(
      step.action.includes('挂载'),
      `an --apply run must mount what it installed, got: ${step.action} (${step.detail ?? ''})`,
    );

    // The mount must be real, not just claimed in the message: it has to point
    // at the file the install actually produced.
    const written = JSON.parse(await readFile(path.join(configDir, 'unified-trial-mcp.config.json'), 'utf8'));
    assert.ok(
      typeof written.paths?.chictrCorpus === 'string' && written.paths.chictrCorpus.length > 0,
      `config must carry chictrCorpus, got: ${JSON.stringify(written.paths)}`,
    );
    const installed = (await import('node:fs')).statSync(written.paths.chictrCorpus);
    assert.ok(
      installed.isFile() && installed.size > 0,
      `the mounted path must be the installed corpus, got: ${written.paths.chictrCorpus}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corpus: a crash between the two renames recovers the previous install instead of losing it', async () => {
  // The swap is two renames: `corpusDir -> corpusDir.old`, then `corpusDir.new
  // -> corpusDir`. An interruption between them leaves corpusDir MISSING and
  // `.old` holding the only surviving copy. This code used to delete `.old`
  // unconditionally on the next run, which turned a recoverable interruption
  // into permanent data loss - contradicting this file's own rule that a failed
  // install never damages what is already installed. These two tests pin the
  // recovery half and the cleanup half separately, because a fix for one can
  // easily break the other.
  const { fetchCorpus } = await load('cli/corpus.js');
  const { mkdtemp, mkdir, readFile, rm, writeFile, stat } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  // NOTE: the table name is fixed to `trials` on purpose. The install verifies
  // the payload by counting rows in SQLITE_TABLE_BY_CORPUS[corpusId], so a
  // fixture using any other table name is rejected with "no such table".
  const buildArchive = async (root, variant) => {
    const payload = path.join(root, `payload-${variant}`);
    await mkdir(payload, { recursive: true });
    const dbFile = path.join(payload, 'chictr_pancreatic.db');
    const { DatabaseSync } = await import('node:sqlite');
    const fixture = new DatabaseSync(dbFile);
    try {
      fixture.exec('CREATE TABLE trials (project_id TEXT PRIMARY KEY)');
      fixture.exec(`INSERT INTO trials (project_id) VALUES ('fixture-${variant}')`);
    } finally {
      fixture.close();
    }
    const archive = path.join(root, `chictr_pancreatic-${variant}.tar.gz`);
    await run('tar', ['-czf', archive, '-C', payload, 'chictr_pancreatic.db']);
    return {
      url: pathToFileURL(archive).href,
      bytes: (await stat(archive)).size,
      sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
      extractDir: 'chictr_pancreatic',
      version: '1',
      title: 't',
      basis: 'upstream_public',
    };
  };

  const root = await mkdtemp(path.join(os.tmpdir(), 'utcd-corpus-recover-'));
  try {
    // ---- Half 1: a surviving `.old` backup must be restored, not deleted.
    const destDir = path.join(root, 'dest');
    const corpusDir = path.join(destDir, 'chictr_pancreatic');
    // The state left behind by a crash between the two renames: the installed
    // directory is gone, and only the backup holds the data.
    const previousDir = `${corpusDir}.old`;
    await mkdir(previousDir, { recursive: true });
    // A REAL database, so the adapter-facing content check can only pass if the
    // restore actually happened.
    const { DatabaseSync } = await import('node:sqlite');
    const survivor = path.join(previousDir, 'chictr_pancreatic.db');
    const db = new DatabaseSync(survivor);
    try {
      db.exec('CREATE TABLE trials (project_id TEXT PRIMARY KEY)');
      db.exec("INSERT INTO trials (project_id) VALUES ('survivor')");
    } finally {
      db.close();
    }

    const entry = await buildArchive(root, 'newer');
    const result = await fetchCorpus(
      { corpusId: 'chictr_pancreatic', destDir, apply: true },
      {
        readManifest: async () => ({ corpora: { chictr_pancreatic: entry } }),
        // Offline on purpose: the recovery must be observable without a network.
        fetchImpl: async () => new Response('unused'),
      },
    );

    assert.ok(
      result.steps.some((step) => step.includes('已恢复')),
      `the interrupted install must be reported as recovered, got: ${JSON.stringify(result.steps)}`,
    );
    // After a successful install the NEW corpus must be in place...
    assert.ok(result.dbPath && (await stat(result.dbPath)).isFile(), 'the new corpus must be installed');
    // ...and the stale backup must be gone, so it cannot shadow future runs.
    await assert.rejects(() => stat(previousDir), 'the recovered backup must not be left behind');

    // ---- Half 2: `.new` must not survive a failed run.
    // A `.new` left by an earlier EXDEV copy or failed rename is a full extra
    // copy and garbage; the recovery step above only ever restores `.old`, so a
    // leftover `.new` would never be cleaned up on later successes either.
    const destDir2 = path.join(root, 'dest2');
    const corpusDir2 = path.join(destDir2, 'chictr_pancreatic');
    await mkdir(`${corpusDir2}.new`, { recursive: true });
    await writeFile(path.join(`${corpusDir2}.new`, 'leftover.txt'), 'garbage');

    const entry2 = await buildArchive(root, 'second');
    await assert.rejects(
      () =>
        fetchCorpus(
          { corpusId: 'chictr_pancreatic', destDir: destDir2, apply: true },
          {
            readManifest: async () => ({ corpora: { chictr_pancreatic: entry2 } }),
            // Fail AFTER staging has been created, so the finally block runs.
            runTar: async () => {
              throw new Error('simulated extraction failure');
            },
          },
        ),
      /simulated extraction failure/,
    );
    await assert.rejects(
      () => stat(`${corpusDir2}.new`),
      'a failed run must not leave a second full copy of the corpus behind',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
            basis: 'upstream_public',
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

test('npm: the published package carries the corpus manifest it reads at runtime', async () => {
  // `fetch-corpus` resolves the manifest from the package root (three levels up
  // from dist/src/cli), so a manifest left out of `files` is invisible when
  // running from the repo and fatal once installed. Nothing in the repo tree
  // can reveal that, so this asks npm what it would actually publish.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const run = promisify(execFile);

  const { stdout } = await run('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, timeout: 120_000 });
  // `prepack` runs the build, whose progress lines land on stdout ahead of the
  // JSON payload, so the document has to be located rather than assumed.
  const [packed] = JSON.parse(stdout.slice(stdout.indexOf('[')));
  const paths = packed.files.map((f) => f.path);

  for (const required of ['corpora/manifest.json', 'dist/src/cli/main.js', 'README.md', 'LICENSE']) {
    assert.ok(
      paths.includes(required),
      `the published tarball must contain ${required}; it would break every install`,
    );
  }

  // Credentials and corpus payloads must never ship, however they got there.
  for (const file of paths) {
    assert.doesNotMatch(file, /cookie\.env$|\.env$|(^|\/)[^/]+\.db$|(^|\/)[^/]+\.tar\.gz$/);
  }
});

test('npm: the package version moves when the published corpus list moves', async () => {
  // `corpora/manifest.json` ships inside the tarball, and fetch-corpus reads the
  // copy in its own package - measured: after editing the repo manifest, an
  // already-installed CLI still reported the old byte count. So a manifest change
  // shipped without a version bump is invisible to every existing user, and
  // nothing else in the suite can see it because the repo tree looks correct.
  //
  // This cannot check history (the bump may legitimately land in a later commit
  // than the manifest edit), so it holds the invariant that is checkable right
  // here and catches the mistake at its source: the manifest git publishes must
  // be committed, and the version must have moved since the manifest last changed.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const run = promisify(execFile);

  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  const { stdout: dirty } = await run('git', ['status', '--porcelain', '--', 'corpora/manifest.json'], {
    cwd: ROOT,
  });
  assert.equal(
    dirty.trim(),
    '',
    'corpora/manifest.json is modified but uncommitted - ship it with an npm version bump, or installed users never see the new corpus',
  );

  // The manifest's own version field is the release tag; the npm version is the
  // transport. A manifest published while package.json still sits at the version
  // that already shipped means the update reached nobody.
  const { stdout: atHead } = await run(
    'git',
    ['log', '-1', '--format=%H', '--', 'package.json'],
    { cwd: ROOT },
  );
  const { stdout: manifestAtHead } = await run(
    'git',
    ['log', '-1', '--format=%H', '--', 'corpora/manifest.json'],
    { cwd: ROOT },
  );
  assert.ok(atHead.trim() && manifestAtHead.trim(), 'both files must be tracked');
  assert.ok(
    pkg.version !== '0.0.0',
    'the package needs a real version before its bundled manifest can reach anyone',
  );
});

test('corpus: the packer refuses a mistyped version instead of publishing a dead URL', async () => {
  // Both the release tag and the asset URL are derived from the version, so a
  // mistyped one produces a URL that 404s for every user forever, and a duplicate
  // one makes `gh release create` refuse. Asserting on source text does not prove
  // the flag is read, so this runs the packer and checks what it does.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const { readFile, writeFile, mkdir, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { ROOT } = await import('./helpers.mjs');
  const run = promisify(execFile);

  // Build a throwaway source dir rather than packing a real corpus: the packer
  // resolves `--source` per corpus from the author's machine by default, so
  // relying on one makes this test pass locally and fail on any clean checkout.
  const source = await mkdtemp(path.join(tmpdir(), 'ut-pack-src-'));
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'ctv.db'), 'not a real database, only bytes\n', 'utf8');

  const manifest = JSON.parse(await readFile(path.join(ROOT, 'corpora', 'manifest.json'), 'utf8'));
  for (const [corpusId, entry] of Object.entries(manifest.corpora)) {
    assert.ok(entry.version, `${corpusId} must declare the version it was published under`);
    // The tag is what a human types into `gh release create` and is embedded in
    // the download URL, so the URL must carry exactly this version segment.
    assert.ok(
      entry.url.includes(`/download/${corpusId}-${entry.version}/`),
      `${corpusId}: the url tag must be "<id>-<version>", got ${entry.url}`,
    );
  }

  // A shape-valid version must be accepted (dry run: no download, no manifest write).
  const ok = await run(
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'pack-corpus.mjs'),
      '--corpus', 'ctv_index',
      '--source', source,
      '--version', '2031-01-02-03',
    ],
    { cwd: ROOT },
  ).catch((error) => error);
  assert.ok(!ok.code, `a valid --version must be accepted, got exit ${ok.code}: ${ok.stderr ?? ''}`);

  // A mistyped one must be refused, and must not quietly fall back to today.
  const bad = await run(
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'pack-corpus.mjs'),
      '--corpus', 'ctv_index',
      '--source', source,
      '--version', '2031/01/02',
    ],
    { cwd: ROOT },
  ).catch((error) => error);
  assert.equal(bad.code, 2, 'a malformed --version must fail with exit code 2');
  assert.match(String(bad.stderr), /--version must look like/, 'and must say what the shape should be');
});

test('corpus: a network failure explains the actual cause, not just "fetch failed"', async () => {
  // Node surfaces connection problems as `TypeError: fetch failed` with the real
  // reason buried in `cause`. Reporting only the outer message collapses DNS
  // failure, a blocked port, a TLS error and a timeout into one useless sentence
  // and sends the user looking in the wrong place.
  const { describeFetchError } = await load('cli/corpus.js');

  const cause = Object.assign(new Error('Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  const wrapper = Object.assign(new TypeError('fetch failed'), { cause });

  const described = describeFetchError(wrapper);
  assert.match(described, /Connect Timeout Error/);
  assert.match(described, /github\.com:443/, 'the host and port must survive, or the user cannot diagnose anything');
  assert.ok(!described.includes('fetch failed'), 'the useless wrapper wording must be dropped, not prepended');

  // Some Node failures arrive as AggregateError with several attempts (e.g. both
  // A and AAAA records); every distinct reason has to reach the user.
  const aggregate = new AggregateError([
    new Error('connect ECONNREFUSED 140.82.1.1:443'),
    new Error('connect ETIMEDOUT 140.82.1.2:443'),
  ]);
  const many = describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: aggregate }));
  assert.match(many, /ECONNREFUSED/);
  assert.match(many, /ETIMEDOUT/);

  // It must terminate and stay readable even on a self-referencing cause chain.
  const loop = new Error('boom');
  loop.cause = loop;
  assert.equal(describeFetchError(loop), 'boom');
});

test('corpus: a download attempt is bounded by a timeout', async () => {
  // Without one, a stalled connection makes a cold start look like a hang rather
  // than a failure a user can act on.
  const { DOWNLOAD_TIMEOUT_MS, fetchCorpus } = await load('cli/corpus.js');
  assert.ok(DOWNLOAD_TIMEOUT_MS >= 30_000, 'a 25 MB asset needs a generous but finite budget');

  let sawSignal = false;
  const destDir = await (await import('node:fs/promises')).mkdtemp(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'utcd-corpus-sig-'),
  );
  await assert.rejects(
    () =>
      fetchCorpus(
        { corpusId: 'chictr_pancreatic', destDir, apply: true },
        {
          readManifest: async () => ({
            corpora: {
              chictr_pancreatic: {
                url: 'https://example.invalid/c.tar.gz',
                bytes: 10,
                sha256: 'd'.repeat(64),
                extractDir: 'chictr_pancreatic',
                version: '1',
                title: 't',
                basis: 'upstream_public',
              },
            },
          }),
          fetchImpl: async (_url, init) => {
            sawSignal = Boolean(init?.signal);
            throw Object.assign(new TypeError('fetch failed'), { cause: new Error('simulated') });
          },
        },
      ),
    () => true,
  );
  assert.equal(sawSignal, true, 'every attempt must carry an abort signal');
  await (await import('node:fs/promises')).rm(destDir, { recursive: true, force: true });
});

test('corpus: the download error surfaced to the user carries the cause', async () => {
  // Guards the WIRING, not just the helper: it is easy to keep a good
  // describeFetchError() and still ship `err.message` to the user.
  const { fetchCorpus } = await load('cli/corpus.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const destDir = await mkdtemp(path.join(os.tmpdir(), 'utcd-corpus-cause-'));
  await assert.rejects(
    () =>
      fetchCorpus(
        { corpusId: 'chictr_pancreatic', destDir, apply: true },
        {
          readManifest: async () => ({
            corpora: {
              chictr_pancreatic: {
                url: 'https://example.invalid/c.tar.gz',
                bytes: 10,
                sha256: 'e'.repeat(64),
                extractDir: 'chictr_pancreatic',
                version: '1',
                title: 't',
                basis: 'upstream_public',
              },
            },
          }),
          fetchImpl: async () => {
            throw Object.assign(new TypeError('fetch failed'), {
              cause: new Error('Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)'),
            });
          },
        },
      ),
    (error) => {
      assert.equal(error.reasonCode, 'DOWNLOAD_FAILED');
      assert.match(error.message, /github\.com:443/, 'the user-facing message must name the failing host');
      assert.match(error.message, /Connect Timeout Error/);
      assert.match(error.fixHint, /DNS|代理|网络策略/);
      return true;
    },
  );
  await rm(destDir, { recursive: true, force: true });
});

test('corpus: an archive corpus installs in the shape its adapter expects', async () => {
  // The two corpora want opposite layouts and getting it wrong is silent:
  //   chictr  - --chictr-corpus names a FILE  -> payload directly under extractDir
  //   xyb_cde - --xyb-archive names the PARENT of packages (the adapter scans it
  //             for subdirectories with summary.json). Installing the package AT
  //             extractDir made the adapter look one level too deep and report
  //             NO_ARCHIVE_PACKAGES ("json、logs、raw、word 均不完整").
  // Real-data verification caught this; this test keeps it caught.
  const { fetchCorpus } = await load('cli/corpus.js');
  const { mkdtemp, mkdir, writeFile, readdir, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const destDir = await mkdtemp(path.join(os.tmpdir(), 'utcd-layout-'));
  const entry = {
    url: 'https://example.invalid/x.tar.gz',
    bytes: 3,
    sha256: 'd'.repeat(64),
    extractDir: 'xyb_cde_pancreatic',
    version: '1',
    title: 't',
    basis: 'community_owned',
  };

  // A fake "tar" that lays down the nested package directory, exactly like the
  // real archive (top level = 胰腺癌/).
  const runTar = async (args) => {
    const extractRoot = args[args.indexOf('-C') + 1];
    const pkg = path.join(extractRoot, '胰腺癌');
    await mkdir(path.join(pkg, 'json'), { recursive: true });
    await writeFile(path.join(pkg, 'summary.json'), '{}');
    await writeFile(path.join(pkg, 'json', 'CTR1.json'), '{}');
  };

  const result = await fetchCorpus(
    { corpusId: 'xyb_cde_pancreatic', destDir, apply: true },
    {
      readManifest: async () => ({ corpora: { xyb_cde_pancreatic: entry } }),
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      sha256File: async () => 'd'.repeat(64),
      runTar,
    },
  );

  // The package must remain a SUBDIRECTORY of corpusDir, or --xyb-archive fails.
  const top = await readdir(result.corpusDir);
  assert.ok(
    top.includes('胰腺癌'),
    `the package must stay nested for --xyb-archive (got ${JSON.stringify(top)})`,
  );
  assert.ok(
    !top.includes('summary.json'),
    'the package contents must not sit directly in corpusDir',
  );
  await rm(destDir, { recursive: true, force: true });
});

test('corpus: an asset without a distribution basis is refused', async () => {
  // ADR-009 exists so nobody can add a redistributable-looking asset without
  // stating WHY it may be redistributed. A field nobody validates is a field
  // nobody fills in, so the install path refuses it.
  const { fetchCorpus } = await load('cli/corpus.js');
  await assert.rejects(
    () =>
      fetchCorpus(
        { corpusId: 'mystery', apply: false },
        {
          readManifest: async () => ({
            corpora: {
              mystery: {
                url: 'https://example.invalid/x.tar.gz',
                bytes: 1,
                sha256: 'e'.repeat(64),
                extractDir: 'mystery',
                version: '1',
                title: 'no basis declared',
              },
            },
          }),
        },
      ),
    (error) => {
      assert.equal(error.reasonCode, 'MANIFEST_BASIS_MISSING');
      assert.match(error.fixHint, /upstream_public/);
      assert.match(error.fixHint, /community_owned/);
      return true;
    },
  );
});

test('corpus: every shipped corpus declares a basis and a real digest', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'corpora', 'manifest.json'), 'utf8'));

  for (const [id, entry] of Object.entries(manifest.corpora)) {
    assert.ok(
      entry.basis === 'upstream_public' || entry.basis === 'community_owned',
      `${id} must declare basis (ADR-009)`,
    );
    assert.ok(/^[0-9a-f]{64}$/.test(entry.sha256), `${id} needs a real sha256`);
    assert.ok(entry.bytes > 0, `${id} needs a real byte count`);
    assert.ok(entry.url.endsWith(`${id}.tar.gz`), `${id}'s asset name must match its id`);
  }
  // The two corpora rest on DIFFERENT grounds; if this ever collapses to one
  // value, ADR-009's distinction has been quietly lost.
  const bases = new Set(Object.values(manifest.corpora).map((e) => e.basis));
  assert.ok(bases.size >= 2, `expected both bases to be represented, saw ${[...bases]}`);
});

test('corpus: each SQLite corpus is verified against the table its adapter reads', async () => {
  // Post-install verification opens the .db and counts rows to prove the install
  // is usable. Assuming `trials` for every .db would fail the CTV index install
  // outright ("no such table: trials") even though its file is perfect - the two
  // corpora store their studies in different tables (`trials` vs `studies`).
  const { fetchCorpus } = await load('cli/corpus.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');

  const destDir = await mkdtemp(path.join(os.tmpdir(), 'utcd-table-'));

  // Build a real, minimal CTV-shaped database: a `studies` table and NO `trials`.
  const runTar = async (args) => {
    const extractRoot = args[args.indexOf('-C') + 1];
    const db = new DatabaseSync(path.join(extractRoot, 'ctv.db'));
    db.exec('CREATE TABLE studies (utn TEXT PRIMARY KEY, nct TEXT)');
    db.exec("INSERT INTO studies VALUES ('UTN1', 'NCT1'), ('UTN2', 'NCT2')");
    db.close();
  };

  const result = await fetchCorpus(
    { corpusId: 'ctv_index', destDir, apply: true },
    {
      readManifest: async () => ({
        corpora: {
          ctv_index: {
            url: 'https://example.invalid/ctv_index.tar.gz',
            bytes: 3,
            sha256: 'f'.repeat(64),
            extractDir: 'ctv_index',
            version: '1',
            title: 't',
            basis: 'community_owned',
          },
        },
      }),
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      sha256File: async () => 'f'.repeat(64),
      runTar,
    },
  );

  // It must have verified `studies`, not `trials`, and said so.
  assert.ok(
    result.steps.some((s) => s.includes('studies') && s.includes('2')),
    `expected verification against the studies table, got ${JSON.stringify(result.steps)}`,
  );
  // The database must sit directly under corpusDir, because --ctv-database names
  // a FILE (unlike --xyb-archive, which names a parent directory).
  assert.equal(result.dbPath, path.join(result.corpusDir, 'ctv.db'));

  await rm(destDir, { recursive: true, force: true });
});
