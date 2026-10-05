/**
 * WHO ICTRP adapter (SPEC 6.3).
 *
 * ICTRP is a lower-bound source: the upstream export is known to be silent
 * about records it does not hold (measured gaps up to ~29% on some queries).
 * Therefore a zero result from this adapter means "this query returned
 * nothing", never "these trials do not exist", and every conclusion carries
 * `isLowerBound` plus `upstream_reported_total` / `records_incomplete`.
 *
 * Upstream contract (`ictrp-mcp-service`, tool `ictrp_search`):
 *   args: { keyword, limit, offset, filters?, sort_by?, descending?, refresh? }
 *   payload: {
 *     status, set_id, matched_rows_returned, upstream_reported_total,
 *     records_incomplete, estimated_missing, offset, limit,
 *     trials: [{ trial_id, source_register, public_title, ... }],
 *     provenance
 *   }
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  AdapterError,
  type AdapterContext,
  type AdapterDetailResult,
  type AdapterEvidenceResult,
  type AdapterSearchResult,
  type CanonicalQuery,
  type EvidenceRef,
  type EvidenceRequest,
  type MaintenanceRequest,
  type MaintenanceResult,
  type RawSourceRecord,
  type RegistryNumber,
  type SourceDescriptor,
  type SourceState,
  type SourceStatus,
} from '../core/types.js';
import { getDescriptor } from '../core/registry.js';
import { checkPathReadable } from '../core/config.js';
import { callUpstreamMcp } from '../core/mcp-transport.js';
import { readPackageEntry, resolveUpstreamEntry } from '../core/mcp-client.js';

/** Registry prefix -> canonical registry label used by the merger. */
const REGISTRY_LABELS: Record<string, string> = {
  clinicaltrials_gov: 'NCT',
  chictr: 'CHICTR',
  jprn: 'JPRN',
  eu_ctr: 'EUCTR',
  isrctn: 'ISRCTN',
  anzctr: 'ANZCTR',
  ctri: 'CTRI',
  drks: 'DRKS',
  irct: 'IRCT',
  kct: 'KCT',
  tctr: 'TCTR',
  who: 'WHO',
};

function registryLabelFor(sourceRegister: string | undefined, trialId: string | undefined): string {
  const key = (sourceRegister ?? '').trim().toLowerCase().replace(/[\s.-]+/g, '_');
  const mapped = REGISTRY_LABELS[key];
  if (mapped) return mapped;
  // ICTRP trial_id commonly looks like `NCT01234567` or `ChiCTR2300077564`.
  const id = (trialId ?? '').trim();
  if (/^NCT\d+/i.test(id)) return 'NCT';
  if (/^ChiCTR\d+/i.test(id)) return 'CHICTR';
  if (/^JPRN-/i.test(id)) return 'JPRN';
  if (/^EUCTR/i.test(id)) return 'EUCTR';
  if (/^ISRCTN/i.test(id)) return 'ISRCTN';
  if (/^CTRI\//i.test(id)) return 'CTRI';
  if (/^DRKS/i.test(id)) return 'DRKS';
  if (key) return key.toUpperCase();
  return 'WHO';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const parts = value.split(/[;,|]/).map((p) => p.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const items = value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  return items.length ? items : undefined;
}

/** ICTRP reports phase as a code such as `PHASE2` / `PHASEI/II`. */
function normalizePhase(value: unknown): string[] | undefined {
  const raw = asStringArray(value) ?? [];
  const out: string[] = [];
  for (const entry of raw) {
    const cleaned = entry.replace(/^PHASE\s*/i, '').trim();
    if (cleaned) out.push(`Phase ${cleaned}`);
  }
  return out.length ? out : undefined;
}

export class IctrpAdapter {
  readonly descriptor: SourceDescriptor;

  constructor() {
    this.descriptor = getDescriptor('ictrp');
  }

  /** Resolves the upstream Node entry, or undefined when not installed. */
  private async entry(ctx: AdapterContext): Promise<string | undefined> {
    const root = ctx.paths.ictrpBundle;
    if (!root) return undefined;
    const direct = await resolveUpstreamEntry(root, [
      'npm/dist/index.js',
      'dist/index.js',
      'dist/src/index.js',
    ]);
    if (direct) return direct;
    return readPackageEntry(path.join(root, 'npm'));
  }

  private async requireEntry(ctx: AdapterContext): Promise<string> {
    const root = ctx.paths.ictrpBundle;
    if (!root) {
      throw new AdapterError('NEEDS_SETUP', 'ICTRP_BUNDLE_NOT_CONFIGURED', '未配置 ICTRP 上游服务目录。', {
        fixHint: '运行 unified-trial-mcp configure，或在配置文件中设置 ictrpBundle 指向 ictrp-mcp-service 目录。',
      });
    }
    const check = await checkPathReadable(root, ctx.paths.evidenceRoots, 'dir');
    if (!check.ok) {
      throw new AdapterError('NEEDS_SETUP', check.reasonCode, check.message, { fixHint: check.fixHint });
    }
    const entry = await this.entry(ctx);
    if (!entry) {
      throw new AdapterError(
        'NEEDS_SETUP',
        'ICTRP_UPSTREAM_NOT_BUILT',
        `目录 ${root} 下未找到已构建的 ICTRP MCP 入口（npm/dist/index.js）。`,
        { fixHint: '在该目录运行 npm install && npm run build；本服务不会自动安装上游依赖。' },
      );
    }
    return entry;
  }

  /** Extracts the search terms; ICTRP takes a single `keyword` string. */
  private keywordFor(query: CanonicalQuery): string {
    const parts: string[] = [];
    for (const candidate of [query.keyword, query.condition, query.terms]) {
      const value = candidate?.trim();
      if (value) parts.push(value);
    }
    if (!parts.length && query.keywords?.length) parts.push(query.keywords.join(' '));
    return parts.join(' ').trim();
  }

  private toRecord(trial: Record<string, unknown>): RawSourceRecord {
    const trialId = asString(trial['trial_id']);
    if (!trialId) {
      throw new AdapterError('FAILED', 'MISSING_SOURCE_RECORD_ID', 'ICTRP 返回的记录缺少 trial_id，无法建立身份。');
    }

    const registryNumbers: RegistryNumber[] = [];
    const label = registryLabelFor(asString(trial['source_register']), trialId);
    registryNumbers.push({ registry: label, value: trialId, primary: true });

    const record: RawSourceRecord = {
      sourceRecordId: trialId,
      registryNumbers,
    };

    const publicTitle = asString(trial['public_title']);
    const scientificTitle = asString(trial['scientific_title']);
    if (scientificTitle) record.title = scientificTitle;
    if (publicTitle) record.publicTitle = publicTitle;
    if (!record.title && publicTitle) record.title = publicTitle;

    const condition = asStringArray(trial['condition']);
    if (condition) record.conditionOrDisease = condition;

    const sponsor = asString(trial['primary_sponsor']);
    const secondary = asStringArray(trial['secondary_sponsor']) ?? [];
    if (sponsor || secondary.length) {
      record.sponsorOrInstitution = sponsor ? [sponsor, ...secondary] : secondary;
    }

    const status = asString(trial['recruitment_status']);
    if (status) record.recruitmentStatus = status;

    const phase = normalizePhase(trial['phase_code']);
    if (phase) record.phase = phase;

    const countries = asStringArray(trial['countries']);
    if (countries) record.countries = countries;

    const registered = asString(trial['registration_date']);
    if (registered) record.dates = { registered };

    const sourceRegister = asString(trial['source_register']);
    if (sourceRegister) {
      record.sourceUrl = `https://trialsearch.who.int/Trial2.aspx?TrialID=${encodeURIComponent(trialId)}`;
    } else {
      record.sourceUrl = `https://trialsearch.who.int/Trial2.aspx?TrialID=${encodeURIComponent(trialId)}`;
    }

    return record;
  }

  async search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const keyword = this.keywordFor(query);
    if (!keyword) {
      throw new AdapterError('FAILED', 'ICTRP_KEYWORD_REQUIRED', 'ICTRP 需要至少一个关键词或适应症。', {
        fixHint: '在 keyword / condition 中提供检索词。',
      });
    }

    const entry = await this.requireEntry(ctx);
    const limit = Math.max(1, Math.min(query.limit ?? 50, this.descriptor.maxResults));
    const offset = Math.max(0, query.offset ?? 0);

    const outcome = await callUpstreamMcp({
      command: process.execPath,
      args: [entry],
      cwd: path.dirname(entry),
      toolName: 'ictrp_search',
      toolArgs: { keyword, limit, offset },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      logger: ctx.logger,
      sourceId: this.descriptor.id,
    });

    const payload = outcome.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      throw new AdapterError('FAILED', 'UPSTREAM_ENVELOPE_UNRECOGNISED', 'ICTRP 返回的载荷不是对象。');
    }

    const status = asString(payload['status']);
    if (status && status !== 'ok') {
      throw new AdapterError('FAILED', 'UPSTREAM_STATUS_NOT_OK', `ICTRP 返回状态 ${status}。`);
    }

    const trialsRaw = payload['trials'];
    if (!Array.isArray(trialsRaw)) {
      throw new AdapterError(
        'FAILED',
        'UPSTREAM_ENVELOPE_UNRECOGNISED',
        'ICTRP 响应中没有 trials 数组；本服务不会把无法解析的响应当作零结果。',
      );
    }

    const records: RawSourceRecord[] = [];
    const warnings: string[] = [];
    for (const trial of trialsRaw) {
      if (!trial || typeof trial !== 'object') continue;
      try {
        records.push(this.toRecord(trial as Record<string, unknown>));
      } catch (error) {
        warnings.push((error as Error).message);
      }
    }

    const rowsReturned = typeof payload['matched_rows_returned'] === 'number'
      ? (payload['matched_rows_returned'] as number)
      : records.length;
    const reportedTotal = typeof payload['upstream_reported_total'] === 'number'
      ? (payload['upstream_reported_total'] as number)
      : undefined;
    const recordsIncomplete = payload['records_incomplete'] === true;
    const estimatedMissing = typeof payload['estimated_missing'] === 'number'
      ? (payload['estimated_missing'] as number)
      : undefined;

    if (recordsIncomplete) {
      warnings.push(
        estimatedMissing !== undefined
          ? `上游标注结果不完整，估计缺失 ${estimatedMissing} 条；ICTRP 导出存在已知静默缺口，零/少结果不能作为“不存在”的结论。`
          : '上游标注结果不完整；ICTRP 导出存在已知静默缺口，零/少结果不能作为“不存在”的结论。',
      );
    }

    const result: AdapterSearchResult = {
      records,
      rowsReturned,
      recordsIncomplete: recordsIncomplete || records.length < rowsReturned,
      truncated: rowsReturned > records.length,
      warnings,
    };
    if (reportedTotal !== undefined) result.upstreamReportedTotal = reportedTotal;
    result.retrievedAt = new Date().toISOString();

    const setId = asString(payload['set_id']);
    if (setId) result.warnings!.push(`上游结果集 set_id=${setId}（可用于本地过滤，无需再次联网）。`);

    return result;
  }

  async getDetail(id: string, ctx: AdapterContext): Promise<AdapterDetailResult> {
    const trialId = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const entry = await this.requireEntry(ctx);
    const outcome = await callUpstreamMcp({
      command: process.execPath,
      args: [entry],
      cwd: path.dirname(entry),
      toolName: 'ictrp_search',
      toolArgs: { keyword: trialId, limit: 5 },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      logger: ctx.logger,
      sourceId: this.descriptor.id,
    });

    const payload = outcome.payload as Record<string, unknown> | undefined;
    const trialsRaw = payload?.['trials'];
    if (!Array.isArray(trialsRaw)) {
      throw new AdapterError('FAILED', 'UPSTREAM_ENVELOPE_UNRECOGNISED', 'ICTRP 详情响应中没有 trials 数组。');
    }
    const match = (trialsRaw as Array<Record<string, unknown>>).find(
      (trial) => asString(trial['trial_id']) === trialId,
    );
    if (!match) {
      throw new AdapterError('NO_RESULTS', 'RECORD_NOT_FOUND', `ICTRP 中未找到 trial_id=${trialId} 的记录。`);
    }
    return { record: this.toRecord(match), rawFields: match, warnings: [] };
  }

  async getEvidence(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult> {
    const trialId = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const maxChars = request.maxExcerptChars ?? 4000;
    const refs: EvidenceRef[] = [];

    // Prefer a real field excerpt: it is traceable evidence, not just a pointer.
    try {
      const detail = await this.getDetail(id, ctx);
      refs.push({
        kind: 'field_excerpt',
        path: `ictrp:${trialId}`,
        sourceUrl: `https://trialsearch.who.int/Trial2.aspx?TrialID=${encodeURIComponent(trialId)}`,
        excerpt: JSON.stringify(detail.rawFields ?? detail.record).slice(0, maxChars),
        capturedAt: new Date().toISOString(),
      });
    } catch (error) {
      refs.push({
        kind: 'field_excerpt',
        path: `ictrp:${trialId}`,
        sourceUrl: `https://trialsearch.who.int/Trial2.aspx?TrialID=${encodeURIComponent(trialId)}`,
        unavailableReason: (error as Error).message,
      });
    }

    refs.push({
      kind: 'field_excerpt',
      path: `ictrp:${trialId}/provenance`,
      sourceUrl: `https://trialsearch.who.int/Trial2.aspx?TrialID=${encodeURIComponent(trialId)}`,
      unavailableReason: 'ICTRP 为在线聚合检索，本服务不保存其原始页面快照；请通过来源链接回溯原文。',
    });

    const root = ctx.paths.ictrpBundle;
    if (root) {
      refs.push({
        kind: 'source_json',
        path: path.join(root, 'cache'),
        unavailableReason: '上游 ICTRP 服务的本地结果集缓存由该服务自行管理，本服务只读引用其路径。',
      });
    }
    return { refs, warnings: [] };
  }

  /**
   * Explicit refresh (SPEC 4.5 / `refresh_ictrp`).
   *
   * A dry run only reports the plan. Applying forces a fresh upstream fetch for
   * the configured keywords (upstream `refresh: true`), and optionally writes a
   * canonical snapshot via `ictrp_snapshot` so the bundle can be shipped or
   * reused offline. Nothing here runs implicitly during a search.
   */
  async maintain(request: MaintenanceRequest, ctx: AdapterContext): Promise<MaintenanceResult> {
    const startedAt = new Date().toISOString();
    const finish = (
      state: SourceState,
      reasonCode: string,
      explanation: string,
      extras?: Partial<MaintenanceResult>,
    ): MaintenanceResult => ({
      sourceId: this.descriptor.id,
      state,
      reasonCode,
      explanation,
      changed: 0,
      skipped: 0,
      failed: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      warnings: [],
      ...extras,
    });

    const keywords = [
      ...(request.keywords ?? []),
      ...(request.keyword ? [request.keyword] : []),
    ]
      .map((keyword) => keyword.trim())
      .filter(Boolean);

    const plan: Record<string, unknown> = {
      action: 'refresh_ictrp',
      keywords,
      force: request.force === true,
      bundleDir: ctx.paths.ictrpBundle ?? null,
      dryRun: request.dryRun !== false,
    };

    const entry = await this.requireEntry(ctx);

    if (request.dryRun !== false) {
      const outcome = await callUpstreamMcp({
        command: process.execPath,
        args: [entry],
        cwd: path.dirname(entry),
        toolName: 'ictrp_cache_status',
        toolArgs: { action: 'list' },
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        logger: ctx.logger,
        sourceId: this.descriptor.id,
      });
      return finish('NOT_QUERIED', 'DRY_RUN', '演练模式：仅读取上游缓存状态，未发起刷新。', {
        details: { ...plan, applied: false, cachedSets: outcome.payload },
      });
    }

    if (!keywords.length) {
      throw new AdapterError(
        'FAILED',
        'ICTRP_KEYWORD_REQUIRED',
        '刷新 ICTRP 需要至少一个关键词；本服务不会在无关键词时全量刷新。',
        { fixHint: '提供 keyword 或 keywords 后重试。' },
      );
    }

    let refreshed = 0;
    let failed = 0;
    const warnings: string[] = [];
    const snapshots: Array<Record<string, unknown>> = [];

    for (const keyword of keywords) {
      try {
        const search = await callUpstreamMcp({
          command: process.execPath,
          args: [entry],
          cwd: path.dirname(entry),
          toolName: 'ictrp_search',
          toolArgs: { keyword, limit: 1, refresh: true },
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
          logger: ctx.logger,
          sourceId: this.descriptor.id,
        });
        refreshed += 1;

        // Best-effort snapshot so the refresh is reusable offline.
        try {
          const snapshot = await callUpstreamMcp({
            command: process.execPath,
            args: [entry],
            cwd: path.dirname(entry),
            toolName: 'ictrp_snapshot',
            toolArgs: { keyword, if_stale: request.force !== true },
            timeoutMs: ctx.timeoutMs,
            signal: ctx.signal,
            logger: ctx.logger,
            sourceId: this.descriptor.id,
          });
          snapshots.push({ keyword, result: snapshot.payload });
        } catch (error) {
          warnings.push(`关键词「${keyword}」刷新成功，但快照写入失败：${(error as Error).message}`);
        }
      } catch (error) {
        failed += 1;
        warnings.push(`关键词「${keyword}」刷新失败：${(error as Error).message}`);
      }
    }

    if (refreshed === 0) {
      return finish('FAILED', 'ICTRP_REFRESH_FAILED', '所有关键词刷新均失败。', {
        failed,
        warnings,
        details: { ...plan, applied: true },
      });
    }

    return finish(
      failed ? 'SUCCESS' : 'SUCCESS',
      failed ? 'OK_WITH_WARNINGS' : 'OK',
      `已刷新 ${refreshed} 个关键词的 ICTRP 缓存${failed ? `，${failed} 个失败` : ''}。`,
      {
        changed: refreshed,
        failed,
        warnings,
        ...(ctx.paths.ictrpBundle ? { artifactRoot: ctx.paths.ictrpBundle } : {}),
        details: { ...plan, applied: true, snapshots },
      },
    );
  }

  async getStatus(ctx: AdapterContext): Promise<SourceStatus> {
    const base: SourceStatus = {
      sourceId: this.descriptor.id,
      label: this.descriptor.label,
      enabled: this.descriptor.enabledByDefault,
      available: false,
      state: 'NEEDS_SETUP',
      reasonCode: 'ICTRP_BUNDLE_NOT_CONFIGURED',
      explanation: '未配置 ICTRP 上游服务目录。',
      freshness: { kind: this.descriptor.freshness },
      coverage: {
        scope: this.descriptor.scope,
        zeroResultMeaning: this.descriptor.zeroResultMeaning,
        indexOrArchiveOnly: false,
      },
      // Lower-bound semantics are a property of the SOURCE, not of its
      // readiness: even an unconfigured ICTRP can never prove absence.
      diagnostics: { lowerBound: true },
    };

    const root = ctx.paths.ictrpBundle;
    if (!root) return base;
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        return { ...base, reasonCode: 'ICTRP_BUNDLE_NOT_A_DIR', explanation: `配置的 ICTRP 路径不是目录：${root}` };
      }
    } catch {
      return {
        ...base,
        reasonCode: 'ICTRP_BUNDLE_MISSING',
        explanation: `配置的 ICTRP 目录不存在：${root}`,
        fixHint: '运行 unified-trial-mcp configure 指向正确的 ictrp-mcp-service 目录。',
      };
    }

    const entry = await this.entry(ctx);
    if (!entry) {
      return {
        ...base,
        state: 'NEEDS_SETUP',
        reasonCode: 'ICTRP_UPSTREAM_NOT_BUILT',
        explanation: `未找到已构建的 ICTRP MCP 入口（${path.join(root, 'npm/dist/index.js')}）。`,
        fixHint: '在该目录运行 npm install && npm run build。',
      };
    }

    return {
      ...base,
      available: true,
      state: 'SUCCESS',
      reasonCode: 'OK',
      explanation: 'ICTRP 上游入口可用；注意上游导出存在已知静默缺口。',
      diagnostics: { entry, lowerBound: true },
    };
  }
}
