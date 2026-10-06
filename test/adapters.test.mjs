/**
 * Adapter contract tests (SPEC 9 “adapter contract” row).
 *
 * These are hermetic: they point every adapter at a temp/missing path so the
 * result depends only on the adapter's own contract handling, never on live
 * network state or the developer's real data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { load, tempDir, writeJson, silentCtx } from './helpers.mjs';

const emptyPaths = {
  configDir: '/tmp/ut-none', workDir: '/tmp/ut-none', evidenceRoots: ['/tmp/ut-none'],
};

test('every adapter reports NEEDS_SETUP (never SUCCESS/zero) when its data path is missing', async () => {
  const { createAdapters } = await load('adapters/index.js');
  const { SOURCE_IDS } = await load('core/registry.js');
  const bundle = createAdapters({ paths: emptyPaths, secrets: { get: () => undefined, has: () => false } });
  assert.equal(bundle.adapters.size, SOURCE_IDS.length);

  for (const [id, adapter] of bundle.adapters) {
    const status = await adapter.getStatus(silentCtx(emptyPaths));
    assert.ok(
      ['NEEDS_SETUP', 'NOT_ENABLED'].includes(status.state),
      `${id} must report a setup state when unconfigured, got ${status.state}`,
    );
    assert.notEqual(status.state, 'SUCCESS');
    assert.notEqual(status.state, 'NO_RESULTS', `${id} must not claim "no results" when unconfigured`);
  }
});

test('offline adapters refuse to be used as write targets', async () => {
  const { createAdapters } = await load('adapters/index.js');
  const bundle = createAdapters({ paths: emptyPaths, secrets: { get: () => undefined, has: () => false } });
  for (const id of ['chictr_pancreatic_archive', 'xyb_chinadrugtrials_archive']) {
    const adapter = bundle.adapters.get(id);
    await assert.rejects(
      () => adapter.maintain({ action: 'sync' }, silentCtx(emptyPaths)),
      (error) => error.reasonCode === 'READ_ONLY_ARCHIVE',
      `${id} must be read-only`,
    );
  }
});

test('chictr pancreatic: missing corpus → NEEDS_SETUP with a configure fixHint', async () => {
  const { ChictrPancreaticAdapter } = await load('adapters/chictr-pancreatic.js');
  const adapter = new ChictrPancreaticAdapter();
  try {
    await adapter.search({ keyword: 'x' }, silentCtx(emptyPaths));
    assert.fail('expected a setup failure');
  } catch (error) {
    assert.equal(error.state, 'NEEDS_SETUP');
    assert.equal(error.reasonCode, 'CORPUS_NOT_CONFIGURED');
    assert.match(error.fixHint, /configure/);
  }
});

test('xyb archive: a directory with no packages → NEEDS_SETUP, not an empty success', async () => {
  const { XybArchiveAdapter } = await load('adapters/xyb-archive.js');
  const dir = await tempDir();
  const paths = { ...emptyPaths, xybArchive: dir, evidenceRoots: [dir] };
  const adapter = new XybArchiveAdapter();
  try {
    await adapter.search({ keyword: 'x' }, silentCtx(paths));
    assert.fail('expected a setup failure');
  } catch (error) {
    assert.equal(error.state, 'NEEDS_SETUP', 'an empty archive must not look like a zero-result success');
    assert.equal(error.reasonCode, 'NO_ARCHIVE_PACKAGES');
  }
  const status = await adapter.getStatus(silentCtx(paths));
  assert.equal(status.state, 'NEEDS_SETUP');
});

test('xyb archive: packages without summary.json are skipped and reported, not silently dropped', async () => {
  const { XybArchiveAdapter } = await load('adapters/xyb-archive.js');
  const root = await tempDir();
  // A usable package.
  const good = path.join(root, 'good');
  await writeJson(path.join(good, 'summary.json'), {
    keywords: '胰腺癌', scrape_time: '2026-09-29T08:02:52.730787', total_records: 1, success_count: 1, fail_count: 0,
    results: [{ reg_no: 'CTR1' }],
  });
  await writeJson(path.join(good, 'json', 'CTR1.json'), {
    schema_version: '1', source: { detail_url: 'https://example.test/d', raw_html_path: 'raw/CTR1_detail.html' },
    reg_no: 'CTR1', scrape_time: '2026-09-29T00:00:00.000000',
    sections: { '基本信息': { '试验状态': '进行中', '首次公示信息日期': '2024-01-30' }, '一、题目和背景信息': { '登记号': 'CTR1', '试验专业题目': '测试题目', '适应症': '胰腺癌', '药物名称': '测试药物' } },
    details: {}, list_info: {}, full_text: '', rag_chunks: [], content_hash: 'abc',
  });
  // An incomplete package (no summary.json) that must be skipped and reported.
  await writeJson(path.join(root, 'incomplete', 'json', 'CTR2.json'), { reg_no: 'CTR2' });

  const paths = { ...emptyPaths, xybArchive: root, evidenceRoots: [root] };
  const adapter = new XybArchiveAdapter();
  const outcome = await adapter.search({ keyword: '胰腺癌' }, silentCtx(paths));
  assert.equal(outcome.records.length, 1);
  assert.ok(
    outcome.warnings.some((w) => w.includes('incomplete')),
    'the skipped package must be named in warnings',
  );
  assert.ok(
    (outcome.incompleteness ?? []).some((i) => String(i).startsWith('packages_skipped')),
    'skips must be surfaced as machine-readable incompleteness, not only prose',
  );
});

test('chictr online: getDetail never substitutes a different trial for the one asked for', async () => {
  // The adapter resolves a project_id into a registration number by searching
  // for it. When no record carries the requested id, the code used to fall back
  // to `records[0]` - the FIRST keyword hit - and return that trial's detail
  // while reporting success. The caller cannot tell, so a clinical lookup for
  // one trial could silently answer with another. "Not found" is the honest
  // answer, and this test pins it.
  const { ChictrOnlineAdapter } = await load('adapters/chictr-online.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { stubUpstreamServer } = await import('./helpers.mjs');

  const root = await mkdtemp(path.join(os.tmpdir(), 'ut-chictr-online-'));
  const serverDir = path.join(root, 'upstream');
  // A stub upstream MCP server. It answers search_trials with ONE record whose
  // project_id is NOT the one asked for, and answers get_trial_detail for that
  // other trial - so any substitution becomes visible as a wrong answer.
  await stubUpstreamServer(serverDir, `
const server = new Server({ name: 'chictr-stub', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'search_trials', description: 's', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_trial_detail', description: 'd', inputSchema: { type: 'object', properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = request.params.name === 'get_trial_detail'
    ? JSON.stringify({ project_id: 'OTHER-PROJECT', registration_number: 'ChiCTR1800020402', basic_info: { title: 'OTHER TRIAL' } })
    : JSON.stringify([{ registration_number: 'ChiCTR1800020402', project_id: 'OTHER-PROJECT', title: 'OTHER TRIAL' }]);
  return { content: [{ type: 'text', text }] };
});
await server.connect(new StdioServerTransport());
`);

  try {
    const adapter = new ChictrOnlineAdapter();
    const paths = { ...emptyPaths, chictrMcpServer: serverDir, evidenceRoots: [root] };

    // The keyword search DOES return a record, so an implementation that falls
    // back to records[0] will "succeed" here. It must not.
    await assert.rejects(
      () => adapter.getDetail('chictr_online:NOT-A-KNOWN-PROJECT-ID', silentCtx(paths, {}, 20_000)),
      (error) => {
        assert.equal(
          error.state,
          'NO_RESULTS',
          `an unknown id must be "not found", not a different trial; got state=${error.state}`,
        );
        assert.equal(error.reasonCode, 'RECORD_NOT_FOUND');
        assert.match(error.message, /无法从 project_id=NOT-A-KNOWN-PROJECT-ID 解析出 ChiCTR 注册号/);
        return true;
      },
    );

    // A direct registration number skips the search and must still work, so the
    // refusal above is not just the whole path failing.
    const detail = await adapter.getDetail('chictr_online:ChiCTR1800020402', silentCtx(paths, {}, 20_000));
    assert.equal(detail.record.sourceRecordId, 'OTHER-PROJECT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chictr online: an upstream error is FAILED, never an assertion that the record is absent', async () => {
  // `payload.error` is equally what an expired session, a throttle or a WAF page
  // returns. NO_RESULTS asserts "queried, genuinely nothing matched", so mapping
  // an upstream error onto it converts a failure into a claim of absence - the
  // exact confusion this service exists to prevent.
  const { ChictrOnlineAdapter } = await load('adapters/chictr-online.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { stubUpstreamServer } = await import('./helpers.mjs');

  const root = await mkdtemp(path.join(os.tmpdir(), 'ut-chictr-err-'));
  const serverDir = path.join(root, 'upstream');
  await stubUpstreamServer(serverDir, `
const server = new Server({ name: 'chictr-stub', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'get_trial_detail', description: 'd', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ error: 'session expired' }) }],
}));
await server.connect(new StdioServerTransport());
`);

  try {
    const adapter = new ChictrOnlineAdapter();
    const paths = { ...emptyPaths, chictrMcpServer: serverDir, evidenceRoots: [root] };
    await assert.rejects(
      () => adapter.getDetail('chictr_online:ChiCTR1800020401', silentCtx(paths, {}, 20_000)),
      (error) => {
        assert.equal(error.state, 'FAILED', `an upstream error must be FAILED, got ${error.state}`);
        assert.equal(error.reasonCode, 'CHICTR_DETAIL_UPSTREAM_ERROR');
        assert.match(error.message, /ChiCTR 详情查询返回错误：session expired/);
        assert.ok(error.fixHint, 'the caller needs a next step');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('xyb archive: a record id cannot escape the archive root', async () => {
  // `parseRecordHandle` upstream validates only the SOURCE half of a
  // `<sourceId>:<sourceRecordId>` handle; the record half is what reaches
  // `path.join` when the adapter looks a record up on disk. Without a check on
  // that half, `xyb_chinadrugtrials_archive:../../../<anything>` resolves
  // outside the archive and its contents come back through the tool response,
  // making the "evidence paths stay inside the allowed roots" promise false.
  const { XybArchiveAdapter } = await load('adapters/xyb-archive.js');
  const root = await tempDir('ut-xyb-escape-');
  const pkg = path.join(root, 'output', '胰腺癌');
  await writeJson(path.join(pkg, 'summary.json'), {
    keywords: '胰腺癌', scrape_time: '2026-09-29T08:02:52.730787',
    total_records: 1, success_count: 1, fail_count: 0, results: [{ reg_no: 'CTR1' }],
  });
  await writeJson(path.join(pkg, 'json', 'CTR1.json'), {
    reg_no: 'CTR1', scrape_time: '2026-09-29T00:00:00.000000',
    source: { detail_url: 'https://example.test/d' },
    sections: { '一、题目和背景信息': { '登记号': 'CTR1', '适应症': '胰腺癌' } },
    details: {}, list_info: {}, full_text: '', rag_chunks: [], content_hash: 'h',
  });

  // A file that MUST NOT be readable through the archive: it sits outside every
  // allowed root, so reaching it is the failure this test exists to catch.
  const outsideDir = await tempDir('ut-xyb-outside-');
  const secretFile = path.join(outsideDir, 'secret.json');
  await writeJson(secretFile, { reg_no: 'LEAKED', sections: { 'x': { 'y': 'LEAKED-CONTENT' } } });

  const paths = { ...emptyPaths, xybArchive: path.join(root, 'output'), evidenceRoots: [path.join(root, 'output')] };
  const adapter = new XybArchiveAdapter();

  const traversals = [
    '../'.repeat(8) + 'secret',
    '..%2F..%2Fsecret',
    '/etc/passwd',
    'a/../../secret',
  ];
  for (const bad of traversals) {
    await assert.rejects(
      () => adapter.getDetail(`xyb_chinadrugtrials_archive:${bad}`, silentCtx(paths)),
      (error) => {
        assert.equal(error.reasonCode, 'INVALID_RECORD_ID', `traversal ${bad} must be refused`);
        assert.ok(error.fixHint, 'the caller needs a next step');
        return true;
      },
      `record id ${bad} must not be used as a path segment`,
    );
    // getEvidence is the other door onto the same filesystem path.
    await assert.rejects(
      () => adapter.getEvidence(`xyb_chinadrugtrials_archive:${bad}`, {}, silentCtx(paths)),
      (error) => error.reasonCode === 'INVALID_RECORD_ID',
      `getEvidence must refuse ${bad} too`,
    );
  }

  // The honest handle still works, so the check rejects traversal rather than
  // disabling the code path.
  const ok = await adapter.getDetail('xyb_chinadrugtrials_archive:CTR1', silentCtx(paths));
  assert.equal(ok.record.sourceRecordId, 'CTR1');
  const text = JSON.stringify(ok);
  assert.ok(!text.includes('LEAKED-CONTENT'), 'nothing outside the archive may be returned');
});

test('xyb archive: a recorded json_path is data, and cannot point outside the archive', async () => {
  // `summary.results[].json_path` comes from an archive somebody else produced,
  // so it is DATA, not configuration this host chose. An absolute path used to
  // be honoured verbatim and a relative one was joined onto each anchor without
  // re-checking the result, so `../../..` in the archive walked straight out.
  const { XybArchiveAdapter } = await load('adapters/xyb-archive.js');
  const root = await tempDir('ut-xyb-jsonpath-');
  const pkg = path.join(root, 'output', '胰腺癌');

  // A file outside every anchor, whose content must never be returned.
  const outsideDir = await tempDir('ut-xyb-jsonpath-outside-');
  const outsideJson = path.join(outsideDir, 'outside.json');
  await writeJson(outsideJson, {
    reg_no: 'CTR7', scrape_time: '2026-09-29T00:00:00.000000',
    sections: { '一、题目和背景信息': { '登记号': 'CTR7', '试验专业题目': 'OUTSIDE-TITLE' } },
    details: {}, list_info: {}, full_text: '', rag_chunks: [], content_hash: 'h',
  });

  await writeJson(path.join(pkg, 'summary.json'), {
    keywords: '胰腺癌', scrape_time: '2026-09-29T08:02:52.730787',
    total_records: 1, success_count: 1, fail_count: 0,
    // Both forms of escape: an absolute path, and a relative one climbing out.
    results: [{ reg_no: 'CTR7', json_path: path.relative(pkg, outsideJson) }],
  });
  // The conventional location holds a legitimate record, so a rejected json_path
  // falls back to it rather than failing the whole lookup.
  await writeJson(path.join(pkg, 'json', 'CTR7.json'), {
    reg_no: 'CTR7', scrape_time: '2026-09-29T00:00:00.000000',
    sections: { '一、题目和背景信息': { '登记号': 'CTR7', '试验专业题目': 'INSIDE-TITLE' } },
    details: {}, list_info: {}, full_text: '', rag_chunks: [], content_hash: 'h',
  });

  const paths = { ...emptyPaths, xybArchive: path.join(root, 'output'), evidenceRoots: [path.join(root, 'output')] };
  const adapter = new XybArchiveAdapter();

  // `search` is the reader that consults `json_path` (getDetail uses the
  // conventional location only), so the escaping path must not be followed here.
  const relative = await adapter.search({ keyword: 'CTR7' }, silentCtx(paths));
  assert.ok(
    !JSON.stringify(relative).includes('OUTSIDE-TITLE'),
    'a relative json_path escaping the archive must never be read',
  );
  assert.ok(
    relative.records.some((r) => r.title === 'INSIDE-TITLE'),
    'the record must still resolve through its conventional in-archive location',
  );

  // The same guard must hold for the absolute form.
  await writeJson(path.join(pkg, 'summary.json'), {
    keywords: '胰腺癌', scrape_time: '2026-09-29T08:02:52.730787',
    total_records: 1, success_count: 1, fail_count: 0,
    results: [{ reg_no: 'CTR7', json_path: outsideJson }],
  });
  const absolute = await adapter.search({ keyword: 'CTR7' }, silentCtx(paths));
  assert.ok(!JSON.stringify(absolute).includes('OUTSIDE-TITLE'), 'an absolute json_path outside the anchors must never be read');
  assert.ok(absolute.records.some((r) => r.title === 'INSIDE-TITLE'));

  // getEvidence resolves the same value and reports it as an evidence path.
  const evidence = await adapter.getEvidence('xyb_chinadrugtrials_archive:CTR7', {}, silentCtx(paths));
  const refs = JSON.stringify(evidence.refs ?? []);
  assert.ok(!refs.includes('outside.json'), 'evidence must not point outside the archive, got: ' + refs);
});

test('xyb archive: nested sections are authoritative over flattened details', async () => {
  const { XybArchiveAdapter } = await load('adapters/xyb-archive.js');
  const root = await tempDir();
  const pkg = path.join(root, '胰腺癌');
  await writeJson(path.join(pkg, 'summary.json'), {
    keywords: '胰腺癌', scrape_time: '2026-09-29T08:02:52.730787', total_records: 1, success_count: 1, fail_count: 0,
    results: [{ reg_no: 'CTR9' }],
  });
  await writeJson(path.join(pkg, 'json', 'CTR9.json'), {
    reg_no: 'CTR9', scrape_time: '2026-09-29T00:00:00.000000',
    source: { detail_url: 'https://example.test/d' },
    sections: { '一、题目和背景信息': { '试验专业题目': '真实题目', '适应症': '胰腺癌', '药物名称': '真实药物' } },
    // The flattened view is known to be malformed/ambiguous in real data.
    details: { '试验专业题目': '错误题目', '药物名称': '12' },
    list_info: {}, full_text: '', rag_chunks: [], content_hash: 'h',
  });
  const paths = { ...emptyPaths, xybArchive: root, evidenceRoots: [root] };
  const adapter = new XybArchiveAdapter();
  const outcome = await adapter.search({ keyword: 'CTR9' }, silentCtx(paths));
  assert.ok(outcome.records.length > 0, 'the record must be found by its registration number');
  const record = outcome.records[0];
  assert.equal(record.title, '真实题目');
  assert.ok(!JSON.stringify(record).includes('错误题目'));
});

test('chictr pancreatic: a literal % in a keyword matches that character, not every record', async () => {
  // The LIKE clauses bind `%<escaped term>%` and rely on `ESCAPE '\'` to make a
  // backslash mean "the next character is literal". SQLite only honours that
  // when the LIKE expression names an ESCAPE character, so with the clause
  // missing, escapeLike()'s `\%` was read as a literal backslash followed by a
  // LIVE wildcard: every record matched. The corpus is built here and now, so
  // this asserts the SQL itself rather than whatever data happens to be around.
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await tempDir('ut-chictr-escape-');
  const dbFile = path.join(dir, 'chictr_pancreatic.db');
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`CREATE TABLE trials (
      project_id TEXT PRIMARY KEY, registration_number TEXT, title TEXT, institution TEXT,
      study_type TEXT, registration_date TEXT, detail_url TEXT, disease TEXT,
      recruitment_status TEXT, sponsor TEXT, study_design TEXT, sample_size TEXT,
      purpose TEXT, fetched_at TEXT, updated_at TEXT, content_sha256 TEXT, html_sha256 TEXT,
      source_year INTEGER, raw_html TEXT, raw_text TEXT
    )`);
    db.exec('CREATE TABLE crawl_log (event TEXT, year INTEGER, at TEXT)');
    db.exec('CREATE TABLE corpus_meta (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare(
      'INSERT INTO trials (project_id, title, disease, updated_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('1', '阿帕替尼 500 mg 剂量探索', '胰腺癌', '2026-01-01T00:00:00Z');
    insert.run('2', '吉西他滨 50% 剂量组', '胰腺癌', '2026-01-02T00:00:00Z');
    insert.run('3', '无关研究', '胰腺癌', '2026-01-03T00:00:00Z');
  } finally {
    db.close();
  }

  const { ChictrPancreaticAdapter } = await load('adapters/chictr-pancreatic.js');
  const adapter = new ChictrPancreaticAdapter();
  const paths = { ...emptyPaths, chictrCorpus: dbFile, evidenceRoots: [dir] };

  // "50%" is a literal percentage, not "5" followed by a wildcard. It must match
  // only the record that actually contains it.
  const percent = await adapter.search({ keyword: '50%', limit: 20 }, silentCtx(paths));
  assert.deepEqual(
    percent.records.map((r) => r.sourceRecordId),
    ['2'],
    'a search for "50%" must match the literal string, not every record',
  );

  // The underscore is the other LIKE wildcard, and must be literal too.
  const underscore = await adapter.search({ keyword: 'a_b', limit: 20 }, silentCtx(paths));
  assert.equal(underscore.records.length, 0, '"_" must not act as a single-character wildcard');

  // A keyword with no wildcard at all still matches normally.
  const plain = await adapter.search({ keyword: '阿帕替尼', limit: 20 }, silentCtx(paths));
  assert.deepEqual(plain.records.map((r) => r.sourceRecordId), ['1']);

  // And a status filter uses the same clause, so it must escape too.
  const status = await adapter.search(
    { keyword: '胰腺癌', status: ['100%'], limit: 20 },
    silentCtx(paths),
  );
  assert.equal(status.records.length, 0, 'a status filter must not treat "%" as a wildcard');
});

test('chictr pancreatic: real corpus, if present, exposes project_id identity and scoping warnings', async (t) => {
  // Opt-in, and never a hardcoded path: CI has no local corpus, and a path that
  // only exists on one machine makes the suite unreproducible.
  const corpus = process.env.UNIFIED_TRIAL_TEST_CHICTR_CORPUS;
  if (!corpus) { t.skip('set UNIFIED_TRIAL_TEST_CHICTR_CORPUS to run this against a real corpus'); return; }
  try { await fs.access(corpus); } catch { t.skip('local corpus not available'); return; }
  const { ChictrPancreaticAdapter } = await load('adapters/chictr-pancreatic.js');
  const paths = { ...emptyPaths, chictrCorpus: corpus, evidenceRoots: [path.dirname(corpus)] };
  const adapter = new ChictrPancreaticAdapter();
  const outcome = await adapter.search({ keyword: '胰腺癌', limit: 2 }, silentCtx(paths, {}, 20000));
  assert.ok(outcome.records.length > 0);
  const record = outcome.records[0];
  assert.equal(record.sourceRecordId, String(record.sourceRecordId));
  assert.ok(
    outcome.warnings.some((w) => w.includes('专题离线语料')),
    'a pancreatic-only corpus must declare its scope limit',
  );
});

test('chinadrugtrials: no cookie → NEEDS_SETUP and never a zero-result success', async () => {
  const { ChinaDrugTrialsAdapter } = await load('adapters/chinadrugtrials.js');
  const adapter = new ChinaDrugTrialsAdapter();
  try {
    await adapter.search({ keyword: '胰腺癌' }, silentCtx(emptyPaths));
    assert.fail('expected a setup failure');
  } catch (error) {
    assert.equal(error.state, 'NEEDS_SETUP');
    assert.equal(error.reasonCode, 'CHINADRUGTRIALS_COOKIE_MISSING');
    assert.match(error.message, /Cookie/i);
  }
});

test('chinadrugtrials: status reports cookie presence as a boolean, never the value', async () => {
  const { ChinaDrugTrialsAdapter } = await load('adapters/chinadrugtrials.js');
  const adapter = new ChinaDrugTrialsAdapter();
  const status = await adapter.getStatus(silentCtx(emptyPaths));
  const text = JSON.stringify(status);
  assert.equal(status.state, 'NEEDS_SETUP');
  assert.ok(!/COOKIE=/i.test(text), 'the cookie value must never appear');
});

test('ictrp: unconfigured bundle → NEEDS_SETUP and lower-bound is still declared', async () => {
  const { IctrpAdapter } = await load('adapters/ictrp.js');
  const adapter = new IctrpAdapter();
  const status = await adapter.getStatus(silentCtx(emptyPaths));
  assert.equal(status.state, 'NEEDS_SETUP');
  assert.equal(status.diagnostics?.['lowerBound'], true, 'ICTRP must always declare lower-bound semantics');
});

test('chinadrugtrials: nested serialized requests do not deadlock', async () => {
  // Detail resolution is composed: getDetail → a list search to find the site's
  // internal id pair → the detail POST. Both layers serialize their outbound
  // requests against one global chain, so a non-reentrant `serialize` makes the
  // outer task wait for the inner task while the inner waits for the outer to
  // release the chain. That hung `get_trial_detail` forever (MCP clients then
  // report "Request timed out"). This asserts the composed path settles.
  const { ChinaDrugTrialsAdapter } = await load('adapters/chinadrugtrials.js');
  const adapter = new ChinaDrugTrialsAdapter();
  const ctx = silentCtx(
    { ...emptyPaths, chinadrugtrialsArchive: '/tmp/ut-none-missing' },
    { CHINADRUGTRIALS_COOKIE: 'stub-cookie-value' },
  );

  // Fail the outbound POST fast and deterministically; the point under test is
  // that the composed promise chain settles rather than hanging.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network disabled in tests');
  };
  try {
    const settled = await Promise.race([
      adapter.getDetail('CTR20240246', ctx).then(
        () => 'resolved',
        (error) => `rejected:${error.reasonCode ?? error.name}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 3000)),
    ]);
    assert.notEqual(settled, 'HUNG', 'the composed detail path must settle, not deadlock');
    assert.match(settled, /^rejected:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chinadrugtrials: a page with no result table is DENIED, never an empty success', async () => {
  // An expired session, a throttle and a WAF interstitial all answer HTTP 200.
  // A page that has neither the result table nor pagination therefore proves
  // nothing about whether the query ran, and returning zero records here would
  // let the orchestrator stamp this source NO_RESULTS — "queried, genuinely
  // nothing matched". That is the false absence this service exists to prevent,
  // so the adapter must refuse to guess.
  const { ChinaDrugTrialsAdapter } = await load('adapters/chinadrugtrials.js');
  const adapter = new ChinaDrugTrialsAdapter();
  const ctx = silentCtx(
    { ...emptyPaths, chinadrugtrialsArchive: '/tmp/ut-none-missing' },
    { CHINADRUGTRIALS_COOKIE: 'stub-cookie-value' },
  );

  const withFetch = async (body, status = 200, run) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': 'text/html' } });
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  // A login/challenge page: no table, no pagination. This is the dangerous case.
  await withFetch('<html><body><h1>请登录</h1></body></html>', 200, async () => {
    await assert.rejects(
      () => adapter.search({ keyword: '胰腺癌' }, ctx),
      (error) => {
        assert.equal(error.state, 'DENIED', `expected DENIED, got ${error.state}`);
        assert.equal(error.reasonCode, 'CHINADRUGTRIALS_NO_RESULT_TABLE');
        assert.match(error.message, /无法确认本次检索是否真正执行/);
        assert.ok(error.fixHint, 'the caller needs a next step');
        return true;
      },
    );
  });

  // A page WITH the result table but no rows is a genuine "nothing matched", and
  // must stay a successful empty result rather than becoming an error.
  await withFetch(
    '<html><body><table class="searchTable"><tr><th>标题</th></tr></table>'
      + '<div>共 0 条记录</div></body></html>',
    200,
    async () => {
      const outcome = await adapter.search({ keyword: '不存在的关键词' }, ctx);
      assert.equal(outcome.records.length, 0);
      assert.ok(
        outcome.warnings.some((w) => w.includes('未命中任何记录')),
        'a confirmed-empty result must say so, got: ' + JSON.stringify(outcome.warnings),
      );
    },
  );
});
