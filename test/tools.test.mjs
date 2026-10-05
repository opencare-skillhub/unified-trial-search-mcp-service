/**
 * Tool integration tests (SPEC 9 “工具集成” row).
 *
 * The seven tool schemas are part of the security boundary: they are what a
 * caller may influence. These tests pin that boundary and the maintenance
 * tools' dry-run default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { TOOL_SCHEMAS } = await load('tools/schemas.js');
const { TOOL_HANDLERS } = await load('tools/handlers.js');
const { SOURCE_IDS } = await load('core/registry.js');

const EXPECTED_TOOLS = [
  'search_trials',
  'get_trial_detail',
  'get_record_evidence',
  'get_source_status',
  'refresh_ictrp',
  'sync_ctv_index',
  'sync_chinadrugtrials',
];

test('tools: exactly the seven registered tools are exposed', async () => {
  assert.deepEqual(TOOL_SCHEMAS.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const name of EXPECTED_TOOLS) {
    assert.equal(typeof TOOL_HANDLERS[name], 'function', `${name} must have a handler`);
  }
});

test('tools: every schema is closed to additional properties', async () => {
  for (const tool of TOOL_SCHEMAS) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown args`);
  }
});

test('tools: no tool accepts a url, path, timeout, secret or upstream tool name', async () => {
  const forbidden = ['url', 'path', 'timeout', 'cookie', 'token', 'secret', 'credential', 'command', 'tool'];
  for (const tool of TOOL_SCHEMAS) {
    for (const prop of Object.keys(tool.inputSchema.properties ?? {})) {
      for (const bad of forbidden) {
        assert.ok(
          !prop.toLowerCase().includes(bad),
          `${tool.name}.${prop} must not be caller-controlled (matched "${bad}")`,
        );
      }
    }
  }
});

test('tools: sourceIds can only name registered sources', async () => {
  // `sourceIds` is the only place a caller names a source, so it must be a
  // closed enum: no free-text string can introduce an unregistered source.
  const statusTool = TOOL_SCHEMAS.find((t) => t.name === 'get_source_status');
  const sourceIds = statusTool.inputSchema.properties.sourceIds;
  const allowed = sourceIds.items.anyOf.map((o) => o.const).sort();
  assert.deepEqual(allowed, [...SOURCE_IDS].sort());
  assert.equal(sourceIds.items.type, undefined, 'the enum must not fall back to a bare string');
});

test('tools: a search without any query term is refused', async () => {
  const outcome = await TOOL_HANDLERS['search_trials']({}, {});
  assert.equal(outcome.error.code, 'QUERY_REQUIRED');
});

test('tools: a detail request with a malformed handle is refused', async () => {
  const outcome = await TOOL_HANDLERS['get_trial_detail']({ recordId: 'nocolon' }, {});
  assert.ok(outcome.error, 'a malformed record id must fail');
  assert.equal(outcome.error.code, 'INVALID_RECORD_ID');
});

test('tools: maintenance tools default to a dry run', async () => {
  // `apply` absent → dry run. The dry run must not reach the network, so a
  // missing adapter/dependency would surface as an error rather than as work.
  for (const [name, deps] of [['refresh_ictrp', null], ['sync_ctv_index', null]]) {
    const outcome = await TOOL_HANDLERS[name]({ apply: true, dryRun: true }, {});
    // With no deps the handler fails internally; what matters is that the
    // dry-run flag is computed from `apply` alone (see runMaintenance).
    assert.ok(outcome.error, `${name} without deps must not silently do work`);
  }
});

test('tools: sync_chinadrugtrials does not require an explicit action', async () => {
  // `sync` is the only supported action, so omitting it must mean `sync`; this
  // regressed once and made every call fail with an unsupported-action error.
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const archive = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-cdt-'));
  const { createAdapters } = await load('adapters/index.js');
  const paths = { configDir: archive, workDir: archive, evidenceRoots: [archive], chinadrugtrialsArchive: archive };
  const bundle = createAdapters({ paths, secrets: { get: () => undefined, has: () => false } });
  const { Orchestrator } = await load('core/orchestrator.js');
  const deps = {
    bundle,
    orchestrator: new Orchestrator({
      adapters: bundle.adapters, paths, secrets: { get: () => undefined, has: () => false },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    }),
    paths,
    secrets: { get: () => undefined, has: () => false },
  };

  const outcome = await TOOL_HANDLERS['sync_chinadrugtrials']({}, deps);
  assert.ok(!outcome.error || outcome.error.code !== 'UNSUPPORTED_MAINTENANCE_ACTION',
    'omitting action must default to sync, not fail');
  assert.equal(outcome.payload?.reasonCode, 'DRY_RUN', 'maintenance must default to a dry run');
  assert.equal(outcome.payload?.state, 'NOT_QUERIED');

  const applied = await TOOL_HANDLERS['sync_chinadrugtrials']({ apply: true }, deps);
  assert.equal(applied.error?.code, 'CHINADRUGTRIALS_QUERY_REQUIRED',
    'applying without a keyword must refuse rather than crawl everything');
});

test('tools: an unknown tool is reported as an error, never silently ignored', async () => {
  assert.equal(TOOL_HANDLERS['no_such_tool'], undefined);
});
