/**
 * Orchestrator (SPEC 3.3, 5.2, 7.1).
 *
 * Guarantees:
 *  - bounded concurrency (default 4) and a global wall-clock deadline (75s)
 *  - longest-processing-time-first start order so slow sources are not starved
 *  - every registered source ends in exactly one terminal SourceState
 *  - a failing source never prevents other sources from returning
 *  - errors are never folded into "zero results"
 */

import {
  AdapterError,
  type AdapterContext,
  type AdapterSearchResult,
  type CanonicalQuery,
  type CanonicalTrialRecord,
  type ResolvedPaths,
  type SecretAccessor,
  type Logger,
  type SourceConclusion,
  type SourceDescriptor,
  type SourceId,
  type SourceState,
  type TrialSourceAdapter,
  type UnifiedSearchResponse,
  wasQueried,
} from './types.js';
import { getDescriptor, registryOrder, resolveRequestedSources, scheduleLongestFirst } from './registry.js';
import { normalizeRecord } from './normalizer.js';
import { mergeRecords, type MergeResult } from './merger.js';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_GLOBAL_DEADLINE_MS = 75_000;

/**
 * The smallest slice of the global budget worth handing to a source.
 *
 * Below this a source cannot complete even a trivial local lookup, so starting it
 * would produce a NO_RESULTS that reads like a real answer while `QUERIED_STATES`
 * counts it as one. 250ms is chosen to be well under the fastest real source
 * (15s) yet far above scheduler jitter, so a source is only refused when its
 * budget is genuinely unusable.
 */
export const MIN_SOURCE_BUDGET_MS = 250;

export const DISCLAIMER =
  '本响应仅汇总已配置来源的检索结果，不等于全网或官网全量。来源终态为 SUCCESS/NO_RESULTS 之外的渠道均未被成功查询，' +
  '其缺失不得解读为“不存在相关试验”。所有结论须回溯来源原文并由人工核验，本服务不提供医疗建议。';

export interface OrchestratorOptions {
  adapters: Map<SourceId, TrialSourceAdapter>;
  paths: ResolvedPaths;
  secrets: SecretAccessor;
  logger: Logger;
  concurrency?: number;
  globalDeadlineMs?: number;
  enabledSources?: Set<SourceId>;
  now?: () => number;
}

export interface SearchOutcome extends UnifiedSearchResponse {
  cancelled: boolean;
}

interface SourceRun {
  descriptor: SourceDescriptor;
  conclusion: SourceConclusion;
  result?: AdapterSearchResult;
}

function freshnessFrom(result: AdapterSearchResult | undefined, descriptor: SourceDescriptor, nowMs: number): SourceConclusion['freshness'] {
  const freshness: SourceConclusion['freshness'] = { kind: descriptor.freshness };
  if (result?.retrievedAt) freshness.retrievedAt = result.retrievedAt;
  if (result?.indexedAt) freshness.indexedAt = result.indexedAt;
  if (result?.scrapedAt) freshness.scrapedAt = result.scrapedAt;
  // The cutoff must survive into search responses, otherwise a zero-result
  // answer from a stale snapshot is indistinguishable from a live one.
  if (result?.dataCutoff) freshness.dataCutoff = result.dataCutoff;
  if (result?.cutoffSource) freshness.cutoffSource = result.cutoffSource;
  if (result?.updateHint) freshness.updateHint = result.updateHint;
  if (descriptor.staleAfterDays !== undefined) {
    freshness.staleAfterDays = descriptor.staleAfterDays;
    const stamp = result?.retrievedAt ?? result?.indexedAt ?? result?.scrapedAt;
    if (stamp) {
      const parsed = Date.parse(stamp);
      if (!Number.isNaN(parsed)) {
        const ageDays = (nowMs - parsed) / 86_400_000;
        freshness.stale = ageDays > descriptor.staleAfterDays;
      }
    }
  }
  return freshness;
}

function baseConclusion(
  descriptor: SourceDescriptor,
  state: SourceState,
  reasonCode: string,
  explanation: string,
  extras: Partial<SourceConclusion> = {},
): SourceConclusion {
  const conclusion: SourceConclusion = {
    sourceId: descriptor.id,
    sourceLabel: descriptor.label,
    state,
    reasonCode,
    explanation,
    attempted: false,
    elapsedMs: 0,
    freshness: { kind: descriptor.freshness },
    coverage: {
      scope: descriptor.scope,
      zeroResultMeaning: descriptor.zeroResultMeaning,
      indexOrArchiveOnly: descriptor.kind !== 'mcp' || descriptor.freshness !== 'cached_network',
    },
    completeness: {
      isLowerBound: Boolean(descriptor.isLowerBound),
      warnings: [],
    },
    ...extras,
  };
  if (descriptor.staleAfterDays !== undefined) conclusion.freshness.staleAfterDays = descriptor.staleAfterDays;
  return conclusion;
}

export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  private buildContext(descriptor: SourceDescriptor, signal: AbortSignal): AdapterContext {
    return {
      signal,
      timeoutMs: descriptor.queryTimeoutMs,
      paths: this.options.paths,
      logger: this.options.logger,
      secrets: this.options.secrets,
    };
  }

  async search(query: CanonicalQuery): Promise<SearchOutcome> {
    const now = this.options.now ?? (() => Date.now());
    const startedMs = now();
    const startedAt = new Date(startedMs).toISOString();

    const enabled = this.options.enabledSources ?? new Set(this.options.adapters.keys());
    const { sources, rejected } = resolveRequestedSources(query.sourceIds, enabled);

    const concurrency = Math.max(1, this.options.concurrency ?? DEFAULT_CONCURRENCY);
    const deadlineMs = this.options.globalDeadlineMs ?? DEFAULT_GLOBAL_DEADLINE_MS;

    const runs = new Map<SourceId, SourceRun>();
    for (const descriptor of sources) {
      runs.set(descriptor.id, {
        descriptor,
        conclusion: baseConclusion(descriptor, 'NOT_QUERIED', 'OVERALL_DEADLINE', '未在总 deadline 前启动。'),
      });
    }

    const scheduled = scheduleLongestFirst(sources);
    const controller = new AbortController();
    const warnings: string[] = [];
    if (rejected.length) {
      warnings.push(`已忽略未注册的来源筛选：${rejected.join(', ')}`);
    }

    const deadlineTimer = setTimeout(() => controller.abort(new Error('OVERALL_DEADLINE')), deadlineMs);
    const deadlinePromise = new Promise<void>((resolve) => {
      const check = () => {
        if (controller.signal.aborted || now() - startedMs >= deadlineMs) resolve();
        else setTimeout(check, 25);
      };
      setTimeout(check, 25);
    });

    const runSource = async (descriptor: SourceDescriptor): Promise<void> => {
      const adapter = this.options.adapters.get(descriptor.id);
      const run = runs.get(descriptor.id)!;
      const sourceStart = now();

      if (!adapter) {
        run.conclusion = baseConclusion(descriptor, 'NOT_ENABLED', 'ADAPTER_NOT_REGISTERED', '该来源未在运行时注册适配器。', {
          attempted: false,
        });
        return;
      }

      // Re-check against the clock here too: a worker can be between the loop
      // check and this point, and `sourceStart` was captured before the adapter
      // lookup. Both paths must agree on what "too late" means.
      if (deadlinePassed() && !run.result) {
        run.conclusion = baseConclusion(descriptor, 'NOT_QUERIED', 'OVERALL_DEADLINE', '总 deadline 已到，未启动该来源。');
        return;
      }

      const remaining = deadlineMs - (now() - startedMs);
      if (remaining <= 0) {
        run.conclusion = baseConclusion(descriptor, 'NOT_QUERIED', 'OVERALL_DEADLINE', '总 deadline 已到，未启动该来源。');
        return;
      }

      // A source handed a sliver of the budget cannot answer, but if it is started
      // anyway its NO_RESULTS is indistinguishable from a real "this source has no
      // such trial" - and NO_RESULTS counts as a completed query (`QUERIED_STATES`).
      // That is exactly the failure this service exists to avoid: absence reported
      // as evidence of absence. Measured: with the deadline 1ms away the queued
      // source still started, ran with `timeoutMs = min(20000, 1) = 1`, and was
      // reported NO_RESULTS. Refusing the start keeps it honestly NOT_QUERIED.
      const timeoutMs = Math.min(descriptor.queryTimeoutMs, remaining);
      if (timeoutMs < MIN_SOURCE_BUDGET_MS) {
        run.conclusion = baseConclusion(
          descriptor,
          'NOT_QUERIED',
          'OVERALL_DEADLINE',
          `总 deadline 剩余 ${Math.max(0, Math.round(remaining))}ms，不足以启动该来源（至少需要 ${MIN_SOURCE_BUDGET_MS}ms），未查询。`,
        );
        return;
      }
      const sourceController = new AbortController();
      const onAbort = () => sourceController.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      // A source aborted by its OWN timeout interrupted the worker, which then
      // returns to its loop and may read a clock that still shows time left. Mark
      // the clock as spent here so the loop cannot start a source on a budget that
      // was consumed by the source that just ended. Without this, a source whose
      // timeout coincides with the deadline can hand off to the next one: measured
      // at 1 in 200 runs idle, 9 in 2000 under load, where the queued source was
      // reported SUCCESS while the search had no budget left to give it.
      const timer = setTimeout(() => {
        sourceController.abort(new Error('SOURCE_TIMEOUT'));
        if (now() - startedMs >= deadlineMs) controller.abort(new Error('OVERALL_DEADLINE'));
      }, timeoutMs);

      const context = this.buildContext(descriptor, sourceController.signal);
      run.conclusion = { ...run.conclusion, attempted: true };

      try {
        const result = await adapter.search(query, context);
        const elapsedMs = now() - sourceStart;
        const rows = result.records.length;
        const freshness = freshnessFrom(result, descriptor, now());
        const completeness: SourceConclusion['completeness'] = {
          isLowerBound: Boolean(descriptor.isLowerBound),
          warnings: [...(result.warnings ?? [])],
        };
        if (result.upstreamReportedTotal !== undefined) completeness.upstreamReportedTotal = result.upstreamReportedTotal;
        if (result.rowsReturned !== undefined) completeness.rowsReturned = result.rowsReturned;
        if (result.recordsIncomplete !== undefined) completeness.recordsIncomplete = result.recordsIncomplete;
        // Adapter-declared incompleteness is machine-readable and must reach the
        // caller: a partial scan that is reported as complete is a false answer.
        if (result.incompleteness?.length) {
          completeness.warnings.push(...result.incompleteness);
          completeness.recordsIncomplete = true;
        }
        if (freshness.stale) completeness.warnings.push(`来源数据已超过 ${descriptor.staleAfterDays} 天未更新。`);

        run.result = result;
        run.conclusion = {
          ...run.conclusion,
          state: rows === 0 ? 'NO_RESULTS' : 'SUCCESS',
          reasonCode: rows === 0 ? 'EMPTY_RESULT_SET' : 'OK',
          explanation:
            rows === 0
              ? descriptor.zeroResultMeaning
              : `来源返回 ${rows} 条记录。`,
          attempted: true,
          elapsedMs,
          resultCount: rows,
          truncated: result.truncated ?? rows >= descriptor.maxResults,
          freshness,
          completeness,
        };
        if (run.conclusion.truncated) {
          run.conclusion.completeness.warnings.push('结果可能被截断，未覆盖来源全部命中。');
        }
        if (run.result?.records.length) {
          run.conclusion.requestedLimit = descriptor.maxResults;
        }
      } catch (error) {
        const elapsedMs = now() - sourceStart;
        run.conclusion = this.conclusionFromError(descriptor, error, elapsedMs, sourceController.signal);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
      }
    };

    const queue = [...scheduled];

    /**
     * Has the global deadline passed?
     *
     * Checked as a CLOCK CONDITION rather than only through `signal.aborted`,
     * because the two are not the same instant. `deadlinePromise` polls every
     * 25ms and can win the race below up to 25ms before `controller.abort()`
     * runs; a worker whose source was interrupted by its OWN source timeout
     * returns to this loop in that window with `signal.aborted` still false.
     * Reading the clock directly closes it.
     *
     * This is a belt-and-braces guard: `runSource` independently refuses to start
     * when no time remains, so a late dequeue cannot on its own reach an adapter.
     * Both checks exist because either one alone leaves the ordering to chance.
     *
     * `raceSettled` is the third leg, and it is the one that is exact rather than
     * approximate. The two clock checks can both pass while `search()` has ALREADY
     * returned: a source whose own timeout fires on the same millisecond tick as
     * the global deadline can reject while `now() - startedMs` still reads one
     * millisecond short, so the worker legitimately dequeues the next source and
     * the caller reads a status for a source that started after the answer was
     * finalised. Reproduced under load: 1 failure in 200 runs, where a queued
     * source reported SUCCESS with `cancelled: false`. Once the race has settled
     * no further source may start, so this flag - not a clock reading - is what
     * makes the boundary exact.
     */
    /**
     * Has the global deadline passed?
     *
     * Checked as a CLOCK CONDITION rather than only through `signal.aborted`,
     * because the two are not the same instant. `deadlinePromise` polls every
     * 25ms and can win the race below up to 25ms before `controller.abort()`
     * runs; a worker whose source was interrupted by its OWN source timeout
     * returns to this loop in that window with `signal.aborted` still false.
     * Reading the clock directly closes it.
     *
     * `raceSettled` closes the remaining window, and it is the exact one. A source
     * is given `Math.min(queryTimeoutMs, remaining)`, so when `remaining` is the
     * smaller term its own timeout fires on the same tick as the global deadline -
     * and just BEFORE it, because the source timer is registered later. The worker
     * then returns from a source aborted with reason SOURCE_TIMEOUT while the
     * clock still reads one millisecond short of the deadline and
     * `signal.aborted` is still false, so both original checks pass and it
     * dequeues the next source. Measured: the queued source started at +8528ms
     * against a 60ms budget, `search()` returned at +66ms, and the outcome
     * reported that source SUCCESS with `cancelled: false` - a source with no
     * time budget left was presented as a normal result. Reproduced in 1 of 200
     * runs idle and 9 of 2000 under load. Once the race has settled, no further
     * source may start, which is what makes the boundary exact.
     */
    let raceSettled = false;

    const deadlinePassed = (): boolean =>
      raceSettled || controller.signal.aborted || now() - startedMs >= deadlineMs;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (deadlinePassed()) return;
        const next = queue.shift();
        if (!next) return;
        await runSource(next);
      }
    };

    await Promise.race([
      Promise.all(Array.from({ length: Math.min(concurrency, scheduled.length || 1) }, () => worker())),
      deadlinePromise,
    ]).catch(() => undefined);
    raceSettled = true;


    controller.abort(new Error('OVERALL_DEADLINE'));
    clearTimeout(deadlineTimer);

    // A source that was never attempted because time ran out. Note this is NOT
    // `queue.length > 0`: a worker may have already dequeued the last item and
    // failed the `remaining <= 0` check inside `runSource`, which leaves the
    // queue empty while still meaning "this source never ran". Deriving it from
    // the conclusions is order-independent and therefore race-free.
    const cancelled = [...runs.values()].some(
      (run) => run.conclusion.state === 'NOT_QUERIED' && run.conclusion.reasonCode === 'OVERALL_DEADLINE',
    );
    for (const descriptor of queue) {
      const run = runs.get(descriptor.id);
      if (!run) continue;
      if (run.conclusion.state === 'NOT_QUERIED' && run.conclusion.reasonCode === 'OVERALL_DEADLINE') {
        run.conclusion.attempted = false;
      }
    }

    const statuses = [...runs.values()]
      .map((run) => run.conclusion)
      .sort((a, b) => registryOrder(a.sourceId) - registryOrder(b.sourceId));

    const records: CanonicalTrialRecord[] = [];
    const normalizationWarnings: string[] = [];
    for (const run of runs.values()) {
      const result = run.result;
      if (!result) continue;
      const descriptor = run.descriptor;
      for (const raw of result.records) {
        try {
          records.push(
            normalizeRecord(raw, descriptor, {
              includeRawFields: false,
              ...(result.retrievedAt ? { retrievedAt: result.retrievedAt } : {}),
              ...(result.indexedAt ? { indexedAt: result.indexedAt } : {}),
              ...(result.scrapedAt ? { scrapedAt: result.scrapedAt } : {}),
            }),
          );
        } catch (error) {
          normalizationWarnings.push(
            `${descriptor.id}: ${(error as Error).message}`,
          );
        }
      }
    }

    const mergeResult: MergeResult = mergeRecords(records);

    const queried: SourceId[] = [];
    const unavailable: SourceId[] = [];
    const notQueried: SourceId[] = [];
    for (const status of statuses) {
      if (wasQueried(status.state)) queried.push(status.sourceId);
      else if (status.state === 'NOT_QUERIED') notQueried.push(status.sourceId);
      else unavailable.push(status.sourceId);
    }

    for (const status of statuses) {
      if (status.state === 'NOT_QUERIED') {
        status.attempted = false;
      }
    }

    const completenessWarnings = [
      ...warnings,
      ...normalizationWarnings,
      ...statuses.flatMap((status) =>
        status.completeness.warnings.map((warning) => `${status.sourceId}: ${warning}`),
      ),
    ];

    const elapsedMs = now() - startedMs;
    return {
      schemaVersion: '1.0',
      query,
      statuses,
      coverage: { queried, unavailable, notQueried },
      completeness: {
        isComplete: notQueried.length === 0 && unavailable.length === 0 && completenessWarnings.length === 0,
        warnings: completenessWarnings,
      },
      totalRecords: mergeResult.records.length,
      records: mergeResult.records,
      overlaps: mergeResult.overlaps,
      startedAt,
      elapsedMs,
      cancelled,
      disclaimer: DISCLAIMER,
    };
  }

  private conclusionFromError(
    descriptor: SourceDescriptor,
    error: unknown,
    elapsedMs: number,
    signal: AbortSignal,
  ): SourceConclusion {
    if (error instanceof AdapterError) {
      const extras: Partial<SourceConclusion> = {
        attempted: true,
        elapsedMs,
        explanation: error.message,
      };
      if (error.fixHint) extras.fixHint = error.fixHint;
      return baseConclusion(descriptor, error.state, error.reasonCode, error.message, extras);
    }

    const aborted = signal.aborted;
    const reason = (signal.reason as Error | undefined)?.message;
    if (aborted && reason === 'SOURCE_TIMEOUT') {
      return baseConclusion(descriptor, 'TIMEOUT', 'SOURCE_TIMEOUT', `${descriptor.label} 在 ${descriptor.queryTimeoutMs}ms 内未返回。`, {
        attempted: true,
        elapsedMs,
        fixHint: '稍后重试，或在配置中确认该来源的运行时可用性（doctor）。',
      });
    }
    if (aborted) {
      return baseConclusion(descriptor, 'NOT_QUERIED', 'OVERALL_DEADLINE', '总 deadline 到达，该来源被取消。', {
        attempted: true,
        elapsedMs,
      });
    }

    return baseConclusion(descriptor, 'FAILED', 'ADAPTER_ERROR', (error as Error)?.message ?? String(error), {
      attempted: true,
      elapsedMs,
      fixHint: '运行 doctor 检查该来源的运行时与数据依赖。',
    });
  }

  /** Status for every registry source, independent of a search call. */
  async status(sourceIds?: readonly string[], includeDiagnostics = false): Promise<SourceConclusion[]> {
    const enabled = this.options.enabledSources ?? new Set(this.options.adapters.keys());
    const { sources } = resolveRequestedSources(sourceIds, enabled);
    const out: SourceConclusion[] = [];
    for (const descriptor of sources) {
      const adapter = this.options.adapters.get(descriptor.id);
      if (!adapter) {
        out.push(baseConclusion(descriptor, 'NOT_ENABLED', 'ADAPTER_NOT_REGISTERED', '该来源未在运行时注册适配器。'));
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('STATUS_TIMEOUT')), Math.min(descriptor.queryTimeoutMs, 10_000));
      const started = Date.now();
      try {
        const status = await adapter.getStatus(this.buildContext(descriptor, controller.signal));
        const conclusion = baseConclusion(descriptor, status.state, status.reasonCode, status.explanation, {
          attempted: status.state !== 'NOT_ENABLED',
          elapsedMs: Date.now() - started,
          freshness: status.freshness,
          coverage: status.coverage,
        });
        if (status.fixHint) conclusion.fixHint = status.fixHint;
        if (includeDiagnostics && status.diagnostics) {
          // `doctor` prints these verbatim, so a nested object must be
          // serialized rather than collapsing into "[object Object]".
          conclusion.completeness.warnings.push(
            ...Object.entries(status.diagnostics).map(([k, v]) => {
              const rendered = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
              return `${k}=${rendered}`;
            }),
          );
        }
        out.push(conclusion);
      } catch (error) {
        out.push(this.conclusionFromError(descriptor, error, Date.now() - started, controller.signal));
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  }

  adaptersFor(sourceIds?: readonly string[]): SourceDescriptor[] {
    const enabled = this.options.enabledSources ?? new Set(this.options.adapters.keys());
    return resolveRequestedSources(sourceIds, enabled).sources;
  }

  descriptorFor(id: SourceId): SourceDescriptor {
    return getDescriptor(id);
  }
}
