/**
 * CTV (Veeva Clinical Trial Viewer) adapter (SPEC 6.4).
 *
 * CTV is a local-index source: ctv.veeva.com/robots.txt forbids crawling
 * /study-search, so the upstream MCP answers from a local SQLite+FTS index.
 * A zero result therefore only ever means "not in this local index", and the
 * adapter always surfaces `coverage.indexed_studies` and the upstream `notice`.
 *
 * Upstream contract (`ctv-mcp-server`, tool `search_studies`):
 *   args: { keyword, condition, sponsor, status[], phase[], country, is_china,
 *           type, start_date_from, start_date_to, updated_since, limit, offset }
 *   payload: { total_matched, returned, offset, query,
 *              coverage: { indexed_studies, detail_coverage,
 *                          eligibility_coverage, sitemap_slugs, db_path },
 *              notice,
 *              hits: [{ utn, nct, slug, briefTitle, officialTitle, acronym,
 *                       overallStatus, phases[], conditions[], leadSponsor,
 *                       startDate, lastUpdatePostDate, countries[], isChina,
 *                       score?, hasDetail, url }] }
 *
 * Tool `get_study_detail`: { study_id, refresh?, include_contacts? }
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  return items.length ? items : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class CtvAdapter {
  readonly descriptor: SourceDescriptor;

  constructor() {
    this.descriptor = getDescriptor('ctv');
  }

  private async entry(ctx: AdapterContext): Promise<string | undefined> {
    const root = ctx.paths.ctvMcpServer ?? this.deriveRootFromDatabase(ctx);
    if (!root) return undefined;
    const direct = await resolveUpstreamEntry(root, ['dist/index.js', 'dist/src/index.js']);
    if (direct) return direct;
    return readPackageEntry(root);
  }

  /**
   * The config records the SQLite database path; the MCP entry usually lives in
   * a sibling checkout. This only supplies a best-effort guess so that `doctor`
   * can be helpful, never a silent substitution of another database.
   */
  private deriveRootFromDatabase(ctx: AdapterContext): string | undefined {
    const db = ctx.paths.ctvDatabase;
    if (!db) return undefined;
    const dir = path.dirname(db);
    return path.basename(dir) === 'src' ? path.dirname(dir) : undefined;
  }

  private async requireEntry(ctx: AdapterContext): Promise<string> {
    const root = ctx.paths.ctvMcpServer;
    if (!root) {
      throw new AdapterError('NEEDS_SETUP', 'CTV_MCP_NOT_CONFIGURED', '未配置 CTV 上游服务目录。', {
        fixHint: '运行 configure，或在配置文件中设置 ctvMcpServer 指向 ctv-mcp-server 目录。',
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
        'CTV_UPSTREAM_NOT_BUILT',
        `目录 ${root} 下未找到已构建的 CTV MCP 入口（dist/index.js）。`,
        { fixHint: '在该目录运行 npm install && npm run build；本服务不会自动安装上游依赖。' },
      );
    }
    return entry;
  }

  async search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const entry = await this.requireEntry(ctx);
    const limit = Math.max(1, Math.min(query.limit ?? 20, this.descriptor.maxResults));
    const offset = Math.max(0, query.offset ?? 0);

    const toolArgs: Record<string, unknown> = { limit, offset };
    const keyword = query.keyword?.trim() || query.terms?.trim();
    if (keyword) toolArgs['keyword'] = keyword;
    else if (query.keywords?.length) toolArgs['keyword'] = query.keywords.join(' ');
    if (query.condition?.trim()) toolArgs['condition'] = query.condition.trim();
    if (query.status?.length) toolArgs['status'] = query.status;
    if (query.phase?.length) toolArgs['phase'] = query.phase;
    if (query.country?.trim()) toolArgs['country'] = query.country.trim();
    if (query.isChina === true) toolArgs['is_china'] = true;
    if (query.startDateFrom) toolArgs['start_date_from'] = query.startDateFrom;
    if (query.startDateTo) toolArgs['start_date_to'] = query.startDateTo;

    if (Object.keys(toolArgs).length === 2) {
      throw new AdapterError('FAILED', 'CTV_QUERY_REQUIRED', 'CTV 需要至少一个检索条件。', {
        fixHint: '提供 keyword、condition、country 或 status 等条件之一。',
      });
    }

    const outcome = await callUpstreamMcp({
      command: process.execPath,
      args: [entry],
      cwd: path.dirname(entry),
      toolName: 'search_studies',
      toolArgs,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      logger: ctx.logger,
      sourceId: this.descriptor.id,
    });

    const payload = outcome.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      throw new AdapterError('FAILED', 'UPSTREAM_ENVELOPE_UNRECOGNISED', 'CTV 返回的载荷不是对象。');
    }

    const hits = payload['hits'];
    if (!Array.isArray(hits)) {
      throw new AdapterError(
        'FAILED',
        'UPSTREAM_ENVELOPE_UNRECOGNISED',
        'CTV 响应中没有 hits 数组；本服务不会把无法解析的响应当作零结果。',
      );
    }

    const coverageRaw = payload['coverage'];
    const coverage = coverageRaw && typeof coverageRaw === 'object'
      ? (coverageRaw as Record<string, unknown>)
      : undefined;
    const indexedStudies = asNumber(coverage?.['indexed_studies']) ?? 0;

    const records: RawSourceRecord[] = [];
    const warnings: string[] = [];
    for (const hit of hits) {
      if (!hit || typeof hit !== 'object') continue;
      try {
        records.push(this.toRecord(hit as Record<string, unknown>));
      } catch (error) {
        warnings.push((error as Error).message);
      }
    }

    const notice = asString(payload['notice']);
    if (notice) warnings.push(notice);
    if (indexedStudies === 0) {
      warnings.push('CTV 本地索引为空；请先运行 sync_ctv_index 或在上游导入 CSV/sitemap 后再检索。');
    }

    const totalMatched = asNumber(payload['total_matched']);
    const returned = asNumber(payload['returned']) ?? records.length;

    const result: AdapterSearchResult = {
      records,
      rowsReturned: totalMatched ?? returned,
      recordsIncomplete: indexedStudies === 0,
      truncated: totalMatched !== undefined && totalMatched > records.length,
      warnings,
    };
    if (totalMatched !== undefined) result.upstreamReportedTotal = totalMatched;
    result.retrievedAt = new Date().toISOString();
    if (coverage) result.coverage = coverage as Record<string, unknown>;

    return result;
  }

  private toRecord(hit: Record<string, unknown>): RawSourceRecord {
    const utn = asString(hit['utn']);
    if (!utn) {
      throw new AdapterError('FAILED', 'MISSING_SOURCE_RECORD_ID', 'CTV 返回的记录缺少 utn，无法建立身份。');
    }

    const registryNumbers: RegistryNumber[] = [];
    const nct = asString(hit['nct']);
    if (nct) registryNumbers.push({ registry: 'NCT', value: nct, primary: false });
    // UTN is CTV's own stable identifier and is canonical for this source.
    registryNumbers.push({ registry: 'UTN', value: utn, primary: true });

    const record: RawSourceRecord = {
      sourceRecordId: utn,
      registryNumbers,
    };

    const brief = asString(hit['briefTitle']);
    const official = asString(hit['officialTitle']);
    if (official) record.title = official;
    if (brief) record.publicTitle = brief;
    if (!record.title && brief) record.title = brief;

    const conditions = asStringArray(hit['conditions']);
    if (conditions) record.conditionOrDisease = conditions;

    const sponsor = asString(hit['leadSponsor']);
    if (sponsor) record.sponsorOrInstitution = [sponsor];

    const status = asString(hit['overallStatus']);
    if (status) record.recruitmentStatus = status;

    const phases = asStringArray(hit['phases']);
    if (phases) record.phase = phases;

    const countries = asStringArray(hit['countries']);
    if (countries) record.countries = countries;

    const start = asString(hit['startDate']);
    const updated = asString(hit['lastUpdatePostDate']);
    if (start || updated) {
      record.dates = {};
      if (start) record.dates.registered = start;
      if (updated) record.dates.updated = updated;
    }

    const url = asString(hit['url']);
    if (url) record.sourceUrl = url;
    else {
      const slug = asString(hit['slug']);
      if (slug) record.sourceUrl = `https://ctv.veeva.com/study/${slug}`;
    }

    const acronym = asString(hit['acronym']);
    if (acronym) record.acronym = acronym;

    return record;
  }

  async getDetail(id: string, ctx: AdapterContext): Promise<AdapterDetailResult> {
    const studyId = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const entry = await this.requireEntry(ctx);
    const outcome = await callUpstreamMcp({
      command: process.execPath,
      args: [entry],
      cwd: path.dirname(entry),
      toolName: 'get_study_detail',
      // include_contacts stays false: the upstream redacts investigator PII by
      // default and this service never widens that.
      toolArgs: { study_id: studyId, refresh: false, include_contacts: false },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      logger: ctx.logger,
      sourceId: this.descriptor.id,
    });

    const payload = outcome.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      throw new AdapterError('FAILED', 'UPSTREAM_ENVELOPE_UNRECOGNISED', 'CTV 详情响应不是对象。');
    }

    const warnings: string[] = [];
    const source = asString(payload['source']);
    if (source) warnings.push(`上游详情来源：${source}。`);

    const detailRaw = payload['detail'];
    const detail = detailRaw && typeof detailRaw === 'object'
      ? (detailRaw as Record<string, unknown>)
      : payload;

    const record = this.detailToRecord(studyId, detail);
    return { record, rawFields: detail, warnings };
  }

  private detailToRecord(studyId: string, detail: Record<string, unknown>): RawSourceRecord {
    const utn = asString(detail['utn']) ?? studyId;
    const registryNumbers: RegistryNumber[] = [];
    const nct = asString(detail['nct']);
    if (nct) registryNumbers.push({ registry: 'NCT', value: nct, primary: false });
    registryNumbers.push({ registry: 'UTN', value: utn, primary: true });

    const record: RawSourceRecord = { sourceRecordId: utn, registryNumbers };
    const title = asString(detail['officialTitle']) ?? asString(detail['briefTitle']);
    if (title) record.title = title;
    const brief = asString(detail['briefTitle']);
    if (brief) record.publicTitle = brief;
    const conditions = asStringArray(detail['conditions']);
    if (conditions) record.conditionOrDisease = conditions;
    const sponsor = asString(detail['leadSponsor']);
    if (sponsor) record.sponsorOrInstitution = [sponsor];
    const status = asString(detail['overallStatus']);
    if (status) record.recruitmentStatus = status;
    const phases = asStringArray(detail['phases']);
    if (phases) record.phase = phases;
    const countries = asStringArray(detail['countries']);
    if (countries) record.countries = countries;
    const slug = asString(detail['slug']);
    if (slug) record.sourceUrl = `https://ctv.veeva.com/study/${slug}`;
    return record;
  }

  async getEvidence(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult> {
    const studyId = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const maxChars = request.maxExcerptChars ?? 4000;
    const refs: EvidenceRef[] = [];

    let detailText: string | undefined;
    try {
      const detail = await this.getDetail(studyId, ctx);
      detailText = JSON.stringify(detail.rawFields);
    } catch (error) {
      refs.push({
        kind: 'field_excerpt',
        path: `ctv:${studyId}`,
        unavailableReason: (error as Error).message,
      });
    }

    if (detailText) {
      refs.push({
        kind: 'field_excerpt',
        path: `ctv:${studyId}`,
        excerpt: detailText.slice(0, maxChars),
        sourceUrl: `https://ctv.veeva.com/study/${encodeURIComponent(studyId)}`,
        capturedAt: new Date().toISOString(),
      });
    }

    const db = ctx.paths.ctvDatabase;
    if (db) {
      refs.push({
        kind: 'source_json',
        path: db,
        unavailableReason: 'CTV 的原始证据保存在其本地 SQLite 索引中；本服务只读引用，不导出整库。',
      });
    }

    return { refs, warnings: [] };
  }

  /**
   * Explicit index maintenance (SPEC 4.6 / `sync_ctv_index`).
   *
   * The CTV index is built either from a CSV export or from the site sitemap.
   * The CSV path is host config, never a caller argument — a tool caller must
   * not be able to point the importer at an arbitrary file.
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

    const mode = request.mode ?? 'sitemap_sync';
    const plan: Record<string, unknown> = {
      action: 'sync_ctv_index',
      mode,
      incremental: request.incremental !== false,
      maxShards: request.maxShards ?? null,
      maxRecords: request.maxRecords ?? null,
      database: ctx.paths.ctvDatabase ?? null,
      csvExport: ctx.paths.ctvCsvExport ?? null,
      dryRun: request.dryRun !== false,
    };

    if (mode === 'csv_import' && !ctx.paths.ctvCsvExport) {
      throw new AdapterError(
        'NEEDS_SETUP',
        'CTV_CSV_EXPORT_NOT_CONFIGURED',
        'CSV 导入模式需要在宿主配置中指定 CTV 导出 CSV 的路径；本服务不接受调用方传入的任意文件路径。',
        { fixHint: '设置 ctvCsvExport 配置项后重试，或改用 mode=sitemap_sync。' },
      );
    }

    const entry = await this.requireEntry(ctx);

    if (request.dryRun !== false) {
      return finish('NOT_QUERIED', 'DRY_RUN', '演练模式：未写入索引。', {
        details: { ...plan, applied: false },
      });
    }

    if (mode === 'csv_import') {
      const outcome = await callUpstreamMcp({
        command: process.execPath,
        args: [entry],
        cwd: path.dirname(entry),
        toolName: 'import_csv_export',
        toolArgs: {
          file_path: ctx.paths.ctvCsvExport,
          backfill_details: request.incremental === false,
          ...(request.maxRecords ? { backfill_limit: Math.min(request.maxRecords, 500) } : {}),
        },
        timeoutMs: Math.max(ctx.timeoutMs, 120_000),
        signal: ctx.signal,
        logger: ctx.logger,
        sourceId: this.descriptor.id,
      });
      const payload = outcome.payload as Record<string, unknown> | undefined;
      const inserted = asNumber(payload?.['inserted']) ?? 0;
      const updated = asNumber(payload?.['updated']) ?? 0;
      return finish('SUCCESS', 'OK', `CSV 导入完成：新增 ${inserted} 条，更新 ${updated} 条。`, {
        changed: inserted + updated,
        ...(ctx.paths.ctvDatabase ? { artifactRoot: ctx.paths.ctvDatabase } : {}),
        details: { ...plan, applied: true, upstream: payload },
      });
    }

    if (mode === 'detail_backfill') {
      const outcome = await callUpstreamMcp({
        command: process.execPath,
        args: [entry],
        cwd: path.dirname(entry),
        toolName: 'backfill_details',
        toolArgs: { limit: Math.min(request.maxRecords ?? 20, 200) },
        timeoutMs: Math.max(ctx.timeoutMs, 120_000),
        signal: ctx.signal,
        logger: ctx.logger,
        sourceId: this.descriptor.id,
      });
      const payload = outcome.payload as Record<string, unknown> | undefined;
      return finish('SUCCESS', 'OK', `详情回填完成：ok=${String(payload?.['ok'] ?? '?')} failed=${String(payload?.['failed'] ?? '?')}。`, {
        changed: asNumber(payload?.['ok']) ?? 0,
        failed: asNumber(payload?.['failed']) ?? 0,
        details: { ...plan, applied: true, upstream: payload },
      });
    }

    // mode === 'sitemap_sync'
    const outcome = await callUpstreamMcp({
      command: process.execPath,
      args: [entry],
      cwd: path.dirname(entry),
      toolName: 'sync_sitemap',
      toolArgs: { max_shards: Math.max(1, Math.min(request.maxShards ?? 1, 60)) },
      timeoutMs: Math.max(ctx.timeoutMs, 120_000),
      signal: ctx.signal,
      logger: ctx.logger,
      sourceId: this.descriptor.id,
    });
    const payload = outcome.payload as Record<string, unknown> | undefined;
    const stored = asNumber(payload?.['slugs_stored']) ?? 0;
    return finish('SUCCESS', 'OK', `sitemap 同步完成：入库 ${stored} 个 slug。`, {
      changed: stored,
      ...(ctx.paths.ctvDatabase ? { artifactRoot: ctx.paths.ctvDatabase } : {}),
      details: { ...plan, applied: true, upstream: payload },
    });
  }

  async getStatus(ctx: AdapterContext): Promise<SourceStatus> {
    const base: SourceStatus = {
      sourceId: this.descriptor.id,
      label: this.descriptor.label,
      enabled: this.descriptor.enabledByDefault,
      available: false,
      state: 'NEEDS_SETUP',
      reasonCode: 'CTV_MCP_NOT_CONFIGURED',
      explanation: '未配置 CTV 上游服务目录。',
      freshness: { kind: this.descriptor.freshness },
      coverage: {
        scope: this.descriptor.scope,
        zeroResultMeaning: this.descriptor.zeroResultMeaning,
        indexOrArchiveOnly: true,
      },
    };

    const db = ctx.paths.ctvDatabase;
    let dbInfo: Record<string, unknown> | undefined;
    if (db) {
      try {
        const stat = await fs.stat(db);
        dbInfo = { path: db, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      } catch {
        dbInfo = { path: db, missing: true };
      }
    }

    const root = ctx.paths.ctvMcpServer;
    if (!root) {
      return {
        ...base,
        explanation: db
          ? `已配置 CTV 数据库 ${db}，但未配置上游 MCP 服务目录，无法发起检索。`
          : '未配置 CTV 上游服务目录，也未配置本地索引数据库。',
        fixHint: '运行 configure --ctv-mcp-server <ctv-mcp-server 目录> 后重试。',
        ...(dbInfo ? { diagnostics: { database: dbInfo } } : {}),
      };
    }

    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        return { ...base, reasonCode: 'CTV_MCP_NOT_A_DIR', explanation: `配置的 CTV 路径不是目录：${root}` };
      }
    } catch {
      return {
        ...base,
        reasonCode: 'CTV_MCP_MISSING',
        explanation: `配置的 CTV 服务目录不存在：${root}`,
      };
    }

    const entry = await this.entry(ctx);
    if (!entry) {
      return {
        ...base,
        reasonCode: 'CTV_UPSTREAM_NOT_BUILT',
        explanation: `未找到已构建的 CTV MCP 入口（${path.join(root, 'dist/index.js')}）。`,
        fixHint: '在该目录运行 npm install && npm run build。',
      };
    }

    return {
      ...base,
      available: true,
      state: 'SUCCESS',
      reasonCode: 'OK',
      explanation: 'CTV 上游入口可用；检索基于本地子集索引，零命中只代表本地索引未命中。',
      diagnostics: { entry, ...(dbInfo ? { database: dbInfo } : {}) },
    };
  }
}
