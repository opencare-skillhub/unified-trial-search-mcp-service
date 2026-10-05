#!/usr/bin/env node
/**
 * CI guard for the service's central promise: a caller may only name a
 * registered source, never an endpoint, path, timeout, or credential.
 *
 * The unit tests already assert this, but they exercise the compiled bundle from
 * inside the test process. This script re-checks it from the outside against the
 * built schemas, so a change that quietly widens the tool surface fails the
 * build even if it somehow passes the suite.
 */

import { TOOL_SCHEMAS } from '../dist/src/tools/schemas.js';
import { SOURCE_IDS } from '../dist/src/core/registry.js';

const FORBIDDEN = /url|uri|path|timeout|deadline|cookie|token|secret|credential|password|command|argv|exec|shell|tool|endpoint|host|header/i;

const failures = [];

// 1. Exactly the documented tools, each sealed against extra properties.
const EXPECTED = [
  'search_trials',
  'get_trial_detail',
  'get_record_evidence',
  'get_source_status',
  'refresh_ictrp',
  'sync_ctv_index',
  'sync_chinadrugtrials',
];
const names = TOOL_SCHEMAS.map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify([...EXPECTED].sort())) {
  failures.push(`tool set changed: expected ${EXPECTED.join(', ')}; got ${names.join(', ')}`);
}

for (const tool of TOOL_SCHEMAS) {
  if (tool.inputSchema?.additionalProperties !== false) {
    failures.push(`${tool.name}: additionalProperties must be false`);
  }
  for (const prop of Object.keys(tool.inputSchema?.properties ?? {})) {
    if (FORBIDDEN.test(prop)) {
      failures.push(`${tool.name}: property "${prop}" lets a caller name an endpoint, path, timeout or secret`);
    }
  }
}

// 2. `sourceIds` must be a closed enum: no free-text string can smuggle in an
//    unregistered source.
const statusTool = TOOL_SCHEMAS.find((t) => t.name === 'get_source_status');
const sourceIds = statusTool?.inputSchema?.properties?.sourceIds;
const allowed = (sourceIds?.items?.anyOf ?? []).map((o) => o.const).sort();
if (JSON.stringify(allowed) !== JSON.stringify([...SOURCE_IDS].sort())) {
  failures.push(`sourceIds enum drifted from the registry: ${allowed.join(', ')} vs ${SOURCE_IDS.join(', ')}`);
}
if (sourceIds?.items?.type) {
  failures.push('sourceIds must not fall back to a bare string type');
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
  process.exit(1);
}

process.stdout.write(`closed-registry invariant holds (${TOOL_SCHEMAS.length} tools, ${SOURCE_IDS.length} sources)\n`);
