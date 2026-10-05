/**
 * MCP tool handlers (SPEC 4).
 *
 * Every handler is a thin, typed shell over the orchestrator and the adapter
 * layer. Rules enforced here:
 *
 *  - Tools never accept a source URL, tool name, timeout, secret or arbitrary
 *    filesystem path. All of those live in the closed registry and config.
 *  - A handler never downgrades a failure into "zero results": errors are
 *    returned as an MCP error with a reason code, or as an explicit state in
 *    the response envelope.
 *  - Read-only tools (4) and maintenance tools (3) are separate entry points,
 *    and maintenance defaults to a dry run.
 */

import {
  AdapterError,
  type CanonicalQuery,
  type EvidenceRequest,
  type ResolvedPaths,
  type SecretAccessor,
  type SourceId,
  type TrialSourceAdapter,
  type MaintenanceRequest,
} from '../core/types.js';
import { Orchestrator } from '../core/orchestrator.js';
import { getDescriptor, isSourceId, SOURCE_IDS } from '../core/registry.js';
import type { AdapterBundle } from '../adapters/index.js';

export interface ToolText {
  [key: string]: unknown;
}

export interface ToolOutcome {
  /** Structured payload; serialized as JSON text and as structuredContent. */
  payload: ToolText;
  /** When set, the tool returns isError: true with this message. */
  error?: { code: string; message: string; fixHint?: string };
}

function ok(payload: ToolText): ToolOutcome {
  return { payload };
}

function fail(code: string, message: string, fixHint?: string): ToolOutcome {
  return { payload: { error: code, message, ...(fixHint ? { fixHint } : {}) }, error: { code, message, fixHint } };
}

export interface ToolDeps {
  bundle: AdapterBundle;
  orchestrator: Orchestrator;
  paths: ResolvedPaths;
  secrets: SecretAccessor;
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AdapterError('FAILED', 'INVALID_ARGUMENT', `参数 ${field} 必须是字符串。`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asPositiveInt(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AdapterError('FAILED', 'INVALID_ARGUMENT', `参数 ${field} 必须是正整数。`);
  }
  return Math.min(parsed, max);
}

function asSourceIds(value: unknown): SourceId[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const ids: SourceId[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !isSourceId(item)) {
      throw new AdapterError(
        'FAILED',
        'UNKNOWN_SOURCE',
        `未注册的来源：${String(item)}；可用来源：${SOURCE_IDS.join(', ')}`,
      );
    }
    ids.push(item);
  }
  return ids;
}

function contextFor(deps: ToolDeps, sourceId: SourceId, timeoutMs?: number) {
  const descriptor = getDescriptor(sourceId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SOURCE_TIMEOUT')), timeoutMs ?? descriptor.queryTimeoutMs);
  return {
    ctx: {
      signal: controller.signal,
      timeoutMs: timeoutMs ?? descriptor.queryTimeoutMs,
      paths: deps.paths,
      secrets: deps.secrets,
      logger: silentLogger,
    },
    done: () => clearTimeout(timer),
  };
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function adapterFor(deps: ToolDeps, id: SourceId): TrialSourceAdapter {
  const adapter = deps.bundle.adapters.get(id);
  if (!adapter) throw new AdapterError('NOT_ENABLED', 'ADAPTER_NOT_REGISTERED', `来源 ${id} 未注册适配器。`);
  return adapter;
}

/** Splits a `sourceId:sourceRecordId` handle. */
export function parseRecordHandle(handle: string): { sourceId: SourceId; sourceRecordId: string } {
  const separator = handle.indexOf(':');
  if (separator <= 0) {
    throw new AdapterError(
      'FAILED',
      'INVALID_RECORD_ID',
      `记录 ID 必须是 "<来源>:<来源记录号>" 形式，例如 chictr_pancreatic_archive:34440；收到：${handle}`,
      { fixHint: '从 search_trials 返回的 recordId 原样传入。' },
    );
  }
  const sourceId = handle.slice(0, separator);
  const sourceRecordId = handle.slice(separator + 1);
  if (!isSourceId(sourceId)) {
    throw new AdapterError('FAILED', 'UNKNOWN_SOURCE', `未知的来源前缀：${sourceId}`);
  }
  if (!sourceRecordId) {
    throw new AdapterError('FAILED', 'INVALID_RECORD_ID', '记录 ID 缺少来源记录号。');
  }
  return { sourceId, sourceRecordId };
}

/** 4.1 search_trials — the single fan-out entry point. */
export async function searchTrials(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    const sourceIds = asSourceIds(args['sourceIds'] ?? args['sources']);
    const query: CanonicalQuery = {
      keyword: asString(args['keyword'], 'keyword'),
      condition: asString(args['condition'], 'condition'),
      terms: asString(args['terms'], 'terms'),
      country: asString(args['country'], 'country'),
      startDateFrom: asString(args['startDateFrom'], 'startDateFrom'),
      startDateTo: asString(args['startDateTo'], 'startDateTo'),
      limit: asPositiveInt(args['limit'], 'limit', 20, 200),
      offset: Math.max(0, (typeof args['offset'] === 'number' ? args['offset'] : Number(args['offset'] ?? 0)) || 0),
      ...(sourceIds ? { sourceIds } : {}),
    };
    if (Array.isArray(args['keywords'])) query.keywords = args['keywords'].filter((k): k is string => typeof k === 'string');
    if (Array.isArray(args['status'])) query.status = args['status'].filter((s): s is string => typeof s === 'string');
    if (Array.isArray(args['phase'])) query.phase = args['phase'].filter((p): p is string => typeof p === 'string');
    if (typeof args['isChina'] === 'boolean') query.isChina = args['isChina'];

    if (!query.keyword && !query.condition && !query.terms && !query.keywords?.length) {
      throw new AdapterError('FAILED', 'QUERY_REQUIRED', 'search_trials 至少需要 keyword、condition、terms 或 keywords 之一。');
    }

    const outcome = await deps.orchestrator.search(query);
    return ok(outcome as unknown as ToolText);
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.reasonCode, error.message, error.fixHint);
    return fail('INTERNAL_ERROR', (error as Error).message);
  }
}

/** 4.2 get_trial_detail */
export async function getTrialDetail(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    const handle = asString(args['recordId'] ?? args['id'], 'recordId');
    if (!handle) throw new AdapterError('FAILED', 'INVALID_ARGUMENT', '缺少 recordId。');
    const { sourceId } = parseRecordHandle(handle);
    const adapter = adapterFor(deps, sourceId);
    if (!adapter.getDetail) {
      throw new AdapterError('NOT_ENABLED', 'DETAIL_UNSUPPORTED', `来源 ${sourceId} 不支持详情查询。`);
    }
    const { ctx, done } = contextFor(deps, sourceId);
    try {
      const detail = await adapter.getDetail(handle, ctx);
      return ok({
        recordId: `${sourceId}:${detail.record.sourceRecordId}`,
        source: { id: sourceId, label: adapter.descriptor.label },
        record: detail.record,
        ...(detail.rawFields ? { rawFields: detail.rawFields } : {}),
        warnings: detail.warnings ?? [],
        disclaimer:
          '详情来自单一来源；不同来源对同一试验的字段可能不一致，结论须回溯来源原文并由人工核验。',
      });
    } finally {
      done();
    }
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.reasonCode, error.message, error.fixHint);
    return fail('INTERNAL_ERROR', (error as Error).message);
  }
}

/** 4.3 get_record_evidence */
export async function getRecordEvidence(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    const handle = asString(args['recordId'] ?? args['id'], 'recordId');
    if (!handle) throw new AdapterError('FAILED', 'INVALID_ARGUMENT', '缺少 recordId。');
    const { sourceId } = parseRecordHandle(handle);
    const adapter = adapterFor(deps, sourceId);
    if (!adapter.getEvidence) {
      throw new AdapterError('NOT_ENABLED', 'EVIDENCE_UNSUPPORTED', `来源 ${sourceId} 不支持原始证据。`);
    }
    const request: EvidenceRequest = {};
    const maxChars = args['maxExcerptChars'];
    if (typeof maxChars === 'number' && maxChars > 0) request.maxExcerptChars = Math.min(maxChars, 20_000);
    if (Array.isArray(args['evidenceKinds'])) {
      request.evidenceKinds = args['evidenceKinds'].filter(
        (kind): kind is NonNullable<EvidenceRequest['evidenceKinds']>[number] => typeof kind === 'string',
      );
    }
    const { ctx, done } = contextFor(deps, sourceId);
    try {
      const evidence = await adapter.getEvidence(handle, request, ctx);
      return ok({
        recordId: handle,
        source: { id: sourceId, label: adapter.descriptor.label },
        refs: evidence.refs,
        warnings: evidence.warnings ?? [],
        note: '证据路径均在配置允许的根目录之内；本服务不读取调用方传入的任意路径。',
      });
    } finally {
      done();
    }
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.reasonCode, error.message, error.fixHint);
    return fail('INTERNAL_ERROR', (error as Error).message);
  }
}

/** 4.4 get_source_status */
export async function getSourceStatus(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    const requested = asSourceIds(args['sourceIds'] ?? args['sources']);
    const includeDiagnostics = args['includeDiagnostics'] === true;
    const statuses = await deps.orchestrator.status(requested, includeDiagnostics);
    const summary = {
      total: statuses.length,
      ready: statuses.filter((s) => s.state === 'SUCCESS').length,
      needsSetup: statuses.filter((s) => s.state === 'NEEDS_SETUP').length,
      notEnabled: statuses.filter((s) => s.state === 'NOT_ENABLED').length,
      other: statuses.filter((s) => !['SUCCESS', 'NEEDS_SETUP', 'NOT_ENABLED'].includes(s.state)).length,
    };
    return ok({
      statuses,
      summary,
      note: '来源状态与检索无关：SUCCESS 表示入口与数据依赖就绪，不代表该来源已包含目标试验。',
    });
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.reasonCode, error.message, error.fixHint);
    return fail('INTERNAL_ERROR', (error as Error).message);
  }
}

/** Maintenance runner shared by the three maintenance tools. */
async function runMaintenance(
  sourceId: SourceId,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolOutcome> {
  const adapter = adapterFor(deps, sourceId);
  if (!adapter.maintain) {
    throw new AdapterError('NOT_ENABLED', 'MAINTENANCE_UNSUPPORTED', `来源 ${sourceId} 不支持维护操作。`);
  }
  // Dry run is the default: applying requires an explicit flag.
  const dryRun = args['apply'] === true ? false : true;
  const request: MaintenanceRequest = {
    dryRun,
    // `action` must be forwarded: adapters dispatch on it (ChinaDrugTrials
    // only supports `sync`), and dropping it made every call fail with
    // UNSUPPORTED_MAINTENANCE_ACTION regardless of what the caller asked.
    ...(typeof args['action'] === 'string' ? { action: args['action'] } : {}),
    ...(typeof args['maxPages'] === 'number' ? { maxPages: Math.max(1, Math.min(args['maxPages'], 10)) } : {}),
    ...(typeof args['keyword'] === 'string' ? { keyword: args['keyword'] } : {}),
    ...(Array.isArray(args['keywords']) ? { keywords: args['keywords'].filter((k): k is string => typeof k === 'string') } : {}),
    ...(args['force'] === true ? { force: true } : {}),
    ...(typeof args['mode'] === 'string' ? { mode: args['mode'] as MaintenanceRequest['mode'] } : {}),
    ...(typeof args['maxRecords'] === 'number' ? { maxRecords: args['maxRecords'] } : {}),
    ...(typeof args['maxShards'] === 'number' ? { maxShards: args['maxShards'] } : {}),
    ...(typeof args['delaySeconds'] === 'number' ? { delaySeconds: args['delaySeconds'] } : {}),
    ...(args['incremental'] === false ? { incremental: false } : {}),
  };
  const { ctx, done } = contextFor(deps, sourceId, 120_000);
  try {
    const result = await adapter.maintain(request, ctx);
    return ok({ ...result, dryRun, note: dryRun ? '本次为演练，未产生任何写入或在线抓取。' : '维护已执行。' });
  } finally {
    done();
  }
}

/** 4.5 refresh_ictrp */
export async function refreshIctrp(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    return await runMaintenance('ictrp', args, deps);
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.reasonCode, error.message, error.fixHint);
    return fail('INTERNAL_ERROR', (error as Error).message);
  }
}

/** 4.6 sync_ctv_index */
export async function syncCtvIndex(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    return await runMaintenance('ctv', args, deps);
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.reasonCode, error.message, error.fixHint);
    return fail('INTERNAL_ERROR', (error as Error).message);
  }
}

/** 4.7 sync_chinadrugtrials */
export async function syncChinadrugtrials(args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  try {
    return await runMaintenance('chinadrugtrials', args, deps);
  } catch (error) {
    if (error instanceof AdapterError) return fail(error.reasonCode, error.message, error.fixHint);
    return fail('INTERNAL_ERROR', (error as Error).message);
  }
}

export const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolOutcome>> = {
  search_trials: searchTrials,
  get_trial_detail: getTrialDetail,
  get_record_evidence: getRecordEvidence,
  get_source_status: getSourceStatus,
  refresh_ictrp: refreshIctrp,
  sync_ctv_index: syncCtvIndex,
  sync_chinadrugtrials: syncChinadrugtrials,
};
