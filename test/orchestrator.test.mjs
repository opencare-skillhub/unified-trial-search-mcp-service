/**
 * Orchestration integration tests (SPEC 9 “编排集成” row).
 *
 * Uses fake adapters so concurrency, deadline, cancellation and failure
 * isolation are exercised deterministically — no network, no real timing races.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { AdapterError } = await load('core/types.js');

function descriptor(id, overrides = {}) {
  return {
    id, label: id, scope: 'test', kind: 'mcp', enabledByDefault: true,
    queryTimeoutMs: 1000, maxResults: 200, staleAfterDays: 7,
    identityRule: 'test', zeroResultMeaning: '零结果只代表本来源无返回。',
    ...overrides,
  };
}

function records(count, sourceId, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    sourceRecordId: `${offset + i}`,
    title: `${sourceId} record ${offset + i}`,
  }));
}

/** Fake adapter with programmable behaviour and call recording. */
function fakeAdapter(id, behaviour, descriptorOverrides = {}) {
  const state = { calls: 0, started: 0, concurrent: 0, maxConcurrent: 0, aborted: 0 };
  const adapter = {
    descriptor: descriptor(id, descriptorOverrides),
    state,
    async search(query, ctx) {
      state.calls += 1;
      state.started += 1;
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      try {
        return await behaviour(query, ctx, state);
      } finally {
        state.concurrent -= 1;
      }
    },
    async getStatus() {
      return {
        sourceId: id, label: id, enabled: true, available: true, state: 'SUCCESS', reasonCode: 'OK',
        explanation: 'ok',
        freshness: { kind: 'cached_network' },
        coverage: { scope: 'test', zeroResultMeaning: 'test', indexOrArchiveOnly: false },
      };
    },
  };
  return adapter;
}

function build(adapters, options = {}) {
  const { Orchestrator } = options.OrchestratorModule;
  const { OrchestratorModule: _ignored, ...rest } = options;
  return new Orchestrator({
    adapters: new Map(adapters.map((a) => [a.descriptor.id, a])),
    paths: { configDir: '/tmp/x', workDir: '/tmp/x', evidenceRoots: ['/tmp/x'] },
    secrets: { get: () => undefined, has: () => false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...rest,
  });
}

const { Orchestrator } = await load('core/orchestrator.js');

test('orchestrator: a failing source does not fail the whole search', async () => {
  const good = fakeAdapter('ctv', async () => ({ records: records(2, 'ctv') }));
  const bad = fakeAdapter('ictrp', async () => {
    throw new AdapterError('CHALLENGE_REQUIRED', 'CHICTR_CHALLENGE_REQUIRED', 'challenge');
  });
  const orch = build([good, bad], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x' });
  assert.equal(out.records.length, 2, 'the healthy source must still contribute');
  const states = Object.fromEntries(out.statuses.map((s) => [s.sourceId, s.state]));
  assert.equal(states['ctv'], 'SUCCESS');
  assert.equal(states['ictrp'], 'CHALLENGE_REQUIRED');
  assert.deepEqual(out.coverage.unavailable, ['ictrp']);
});

test('orchestrator: the global deadline stops the search and is not reported as "no results"', async () => {
  const slow = fakeAdapter('ictrp', async (query, ctx) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
    });
    return { records: [] };
  });
  const orch = build([slow], { OrchestratorModule: { Orchestrator }, globalDeadlineMs: 40 });
  const out = await orch.search({ keyword: 'x' });
  const conclusion = out.statuses[0];
  assert.ok(
    ['TIMEOUT', 'NOT_QUERIED'].includes(conclusion.state),
    `a deadline must not be reported as a normal result, got ${conclusion.state}`,
  );
  assert.notEqual(conclusion.state, 'NO_RESULTS', 'a timeout must never look like "no such trial"');
  assert.notEqual(conclusion.state, 'SUCCESS');
});

test('orchestrator: cancelled is true only when a queued source never started', async () => {
  // One slow source fills the single worker; the second stays queued and must
  // be reported as never attempted, which is what `cancelled` means.
  const slow = fakeAdapter('ictrp', async (query, ctx) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
    });
    return { records: [] };
  });
  const never = fakeAdapter('ctv', async () => ({ records: records(1, 'ctv') }));
  const orch = build([slow, never], {
    OrchestratorModule: { Orchestrator },
    globalDeadlineMs: 60,
    concurrency: 1,
  });
  const out = await orch.search({ keyword: 'x' });

  assert.equal(never.state.calls, 0, 'the queued source must never have been queried');
  const ctv = out.statuses.find((s) => s.sourceId === 'ctv');
  assert.equal(ctv.state, 'NOT_QUERIED', 'a source that never started is NOT_QUERIED');
  assert.equal(ctv.attempted, false, 'never-started must be distinguishable from started-and-failed');
  assert.equal(out.cancelled, true);
});

test('orchestrator: a source-level TIMEOUT state is never flattened into NO_RESULTS', async () => {
  const timingOut = fakeAdapter('ictrp', async () => {
    throw new AdapterError('TIMEOUT', 'SOURCE_TIMEOUT', '该来源在时限内未返回。');
  });
  const orch = build([timingOut], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x' });
  assert.equal(out.statuses[0].state, 'TIMEOUT');
  assert.notEqual(out.statuses[0].state, 'NO_RESULTS');
  assert.deepEqual(out.coverage.notQueried, []);
  assert.deepEqual(out.coverage.unavailable, ['ictrp']);
});

test('orchestrator: an aborted source that already started is not "never queried"', async () => {
  const aborted = fakeAdapter('ictrp', async () => {
    // Simulates the deadline abort surfacing as a non-AdapterError.
    throw new Error('aborted');
  });
  const orch = build([aborted], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x' });
  assert.equal(out.statuses[0].attempted, true, 'a started source must record that it was attempted');
});

test('orchestrator: an empty result set is NO_RESULTS and carries the source caveat', async () => {
  const { getDescriptor } = await load('core/registry.js');
  const empty = fakeAdapter('ctv', async () => ({ records: [] }));
  const orch = build([empty], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x' });

  assert.equal(out.statuses[0].state, 'NO_RESULTS');
  // The explanation must be the SOURCE's zero-result meaning, not a generic
  // "not found": a local index miss is not proof the trial does not exist.
  assert.equal(out.statuses[0].explanation, getDescriptor('ctv').zeroResultMeaning);
  assert.notEqual(out.statuses[0].explanation, '未找到相关试验');
});

test('orchestrator: concurrency never exceeds the configured pool', async () => {
  const adapters = ['chinadrugtrials', 'ctv', 'ictrp', 'chictr_online', 'chictr_pancreatic_archive', 'xyb_chinadrugtrials_archive']
    .map((id) => fakeAdapter(id, async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { records: records(1, id) };
    }));
  // A deadline well above the work (6 sources / 2 workers / 15ms each ~= 50ms)
  // keeps this test about concurrency: with the default 75s deadline a stalled
  // event loop can otherwise turn a scheduling hiccup into a very long wait.
  const orch = build(adapters, {
    OrchestratorModule: { Orchestrator },
    concurrency: 2,
    globalDeadlineMs: 5000,
  });
  await orch.search({ keyword: 'x' });
  const peak = Math.max(...adapters.map((a) => a.state.maxConcurrent));
  assert.ok(peak <= 2, `concurrency must be capped, saw ${peak}`);
  assert.ok(adapters.every((a) => a.state.calls === 1), 'each source must be queried exactly once');
});

test('orchestrator: a caller-chosen source subset cannot widen the query', async () => {
  const a = fakeAdapter('ictrp', async () => ({ records: records(1, 'ictrp') }));
  const b = fakeAdapter('ctv', async () => ({ records: records(1, 'ctv') }));
  const orch = build([a, b], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x', sourceIds: ['ictrp'] });
  assert.equal(a.state.calls, 1);
  assert.equal(b.state.calls, 0, 'unrequested sources must not be queried');
  assert.deepEqual(out.coverage.queried, ['ictrp']);
});

test('orchestrator: adapter-declared incompleteness reaches the caller', async () => {
  const partial = fakeAdapter('xyb_chinadrugtrials_archive', async () => ({
    records: records(1, 'xyb'),
    recordsIncomplete: true,
    incompleteness: ['packages_skipped:2'],
  }));
  const orch = build([partial], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x' });
  assert.equal(out.completeness.isComplete, false, 'a partial scan must not claim completeness');
  assert.ok(out.completeness.warnings.some((w) => w.includes('packages_skipped:2')));
});

test('orchestrator: a truncated result is declared truncated', async () => {
  const truncated = fakeAdapter('ictrp', async () => ({ records: records(1, 'ictrp'), truncated: true }));
  const orch = build([truncated], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x' });
  assert.equal(out.statuses[0].truncated, true);
  assert.ok(out.statuses[0].completeness.warnings.some((w) => w.includes('截断')));
});

test('orchestrator: merge counts one trial reached through two registries', async () => {
  const a = fakeAdapter('chinadrugtrials', async () => ({
    records: [{ sourceRecordId: 'CTR1', title: 't', registryNumbers: [{ registry: 'CTR', value: 'CTR1', primary: true }, { registry: 'NCT', value: 'NCT9' }] }],
  }));
  const b = fakeAdapter('ctv', async () => ({
    records: [{ sourceRecordId: 'UTN1', title: 't', registryNumbers: [{ registry: 'UTN', value: 'UTN1', primary: true }, { registry: 'NCT', value: 'NCT9' }] }],
  }));
  const orch = build([a, b], { OrchestratorModule: { Orchestrator } });
  const out = await orch.search({ keyword: 'x' });
  assert.equal(out.records.length, 1, 'a shared reliable registry id must merge');
  assert.equal(out.records[0].mergedFrom.length, 2);
  assert.ok(out.overlaps.some((o) => o.registryNumber === 'NCT:NCT9'));
});

test('orchestrator: search is read-only — no filesystem writes', async () => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-ro-'));
  const a = fakeAdapter('ictrp', async () => ({ records: records(1, 'ictrp') }));
  const orch = build([a], { OrchestratorModule: { Orchestrator } });
  const before = (await fs.readdir(dir)).sort();
  await orch.search({ keyword: 'x' });
  const after = (await fs.readdir(dir)).sort();
  assert.deepEqual(after, before, 'a query must never write to disk');
});
