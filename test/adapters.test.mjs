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

test('chictr pancreatic: real corpus, if present, exposes project_id identity and scoping warnings', async (t) => {
  const corpus = '/Users/qinxiaoqiang/Downloads/chictr_trials/data/chictr_pancreatic.db';
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
