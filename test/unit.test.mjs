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
