/**
 * ChiCTR pancreatic-cancer offline corpus adapter (SPEC 6.2).
 *
 * Scope is exactly this one offline pancreatic-cancer corpus. It is NOT all of
 * ChiCTR and must never be described as such. Identity is `project_id` because
 * registration_number is nullable for pre-2018 records.
 */

import { DatabaseSync } from 'node:sqlite';
import { AdapterError } from '../core/types.js';
import type {
  AdapterContext,
  AdapterDetailResult,
  AdapterEvidenceResult,
  AdapterSearchResult,
  CanonicalQuery,
  EvidenceRequest,
  EvidenceRef,
  RawSourceRecord,
  SourceDescriptor,
  SourceStatus,
} from '../core/types.js';
import { getDescriptor } from '../core/registry.js';
import { checkPathReadable } from '../core/config.js';
import { SOURCE_IDS } from '../core/registry.js';

interface TrialRow {
  project_id: string;
  registration_number: string | null;
  title: string | null;
  institution: string | null;
  study_type: string | null;
  registration_date: string | null;
  detail_url: string | null;
  disease: string | null;
  recruitment_status: string | null;
  sponsor: string | null;
  study_design: string | null;
  sample_size: string | null;
  purpose: string | null;
  fetched_at: string | null;
  updated_at: string | null;
  content_sha256: string | null;
  html_sha256: string | null;
  raw_html?: string | null;
  raw_text?: string | null;
}

const SELECT_COLUMNS = `
  project_id, registration_number, title, institution, study_type, registration_date,
  detail_url, disease, recruitment_status, sponsor, study_design, sample_size, purpose,
  fetched_at, updated_at, content_sha256, html_sha256
`;

/** Free-text columns scanned by a keyword search; one bound placeholder each. */
const SEARCH_COLUMNS = ['title', 'disease', 'purpose', 'sponsor', 'institution'] as const;

export class ChictrPancreaticAdapter {
  readonly descriptor: SourceDescriptor;

  constructor() {
    this.descriptor = getDescriptor('chictr_pancreatic_archive');
  }

  private async openAndCheck(ctx: AdapterContext): Promise<DatabaseSync> {
    const file = ctx.paths.chictrCorpus;
    if (!file) {
      throw new AdapterError('NEEDS_SETUP', 'CORPUS_NOT_CONFIGURED', '未配置 ChiCTR 胰腺癌离线语料路径。', {
        fixHint: '运行 unified-trial-mcp configure --chictr-corpus <chictr_pancreatic.db 的绝对路径>。',
      });
    }
    const check = await checkPathReadable(file, ctx.paths.evidenceRoots, 'file');
    if (!check.ok) {
      throw new AdapterError('NEEDS_SETUP', check.reasonCode, check.message, { fixHint: check.fixHint });
    }
    try {
      return new DatabaseSync(file, { readOnly: true });
    } catch (error) {
      throw new AdapterError('NEEDS_SETUP', 'CORPUS_UNREADABLE', `无法打开离线语料：${(error as Error).message}`, {
        fixHint: '确认该文件是有效的 SQLite 数据库且未被占用。',
      });
    }
  }

  async search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const db = await this.openAndCheck(ctx);
    try {
      const terms = extractTerms(query);
      const limit = Math.max(1, Math.min(query.limit ?? 50, this.descriptor.maxResults));
      const offset = Math.max(0, query.offset ?? 0);

      const where: string[] = [];
      const params: Array<string | number> = [];
      if (terms.length) {
        // Parameters are bound, never interpolated. Each term contributes one
        // clause holding exactly SEARCH_COLUMNS placeholders, so the parameter
        // list must grow by SEARCH_COLUMNS entries per term to stay aligned.
        const columns = SEARCH_COLUMNS.length;
        const clauses: string[] = [];
        for (const term of terms) {
          clauses.push(`(${SEARCH_COLUMNS.map((column) => `${column} LIKE ?`).join(' OR ')})`);
          const like = `%${escapeLike(term)}%`;
          for (let i = 0; i < columns; i += 1) params.push(like);
        }
        where.push(`(${clauses.join(' OR ')})`);
      }
      if (query.status?.length) {
        where.push(`(${query.status.map(() => 'recruitment_status LIKE ?').join(' OR ')})`);
        for (const status of query.status) params.push(`%${escapeLike(status)}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = db
        .prepare(`SELECT COUNT(*) AS c FROM trials ${whereSql}`)
        .get(...params) as { c: number } | undefined;

      const rows = db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM trials ${whereSql} ORDER BY project_id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as unknown as TrialRow[];

      const meta = readCorpusMeta(db);
      const records = rows.map((row) => toRecord(row));
      const upstreamTotal = total?.c ?? rows.length;

      const result: AdapterSearchResult = {
        records,
        upstreamReportedTotal: upstreamTotal,
        rowsReturned: rows.length,
        recordsIncomplete: false,
        truncated: offset + rows.length < upstreamTotal,
        warnings: [],
      };
      if (meta.fetchedAt) result.scrapedAt = meta.fetchedAt;
      result.warnings!.push('本来源仅为胰腺癌专题离线语料，不覆盖 ChiCTR 全量，也不覆盖其他疾病领域。');
      if (meta.detailFailures > 0) {
        result.warnings!.push(`该语料采集日志记录了 ${meta.detailFailures} 条详情抓取失败，相关记录字段可能不完整。`);
      }
      if (meta.unparsedYears.length) {
        result.warnings!.push(`语料中这些年份缺少完成事件，可能不完整：${meta.unparsedYears.join(', ')}。`);
      }
      return result;
    } finally {
      db.close();
    }
  }

  async getDetail(id: string, ctx: AdapterContext): Promise<AdapterDetailResult> {
    const db = await this.openAndCheck(ctx);
    try {
      const projectId = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
      const row = db
        .prepare('SELECT *, raw_html, raw_text FROM trials WHERE project_id = ?')
        .get(projectId) as unknown as TrialRow | undefined;
      if (!row) {
        throw new AdapterError('NO_RESULTS', 'RECORD_NOT_FOUND', `离线语料中不存在 project_id=${projectId} 的记录。`, {
          fixHint: '确认 recordId 来自本服务的该来源结果。',
        });
      }
      const rawFields: Record<string, unknown> = { ...row };
      delete rawFields.raw_html;
      delete rawFields.raw_text;
      try {
        const fieldsJson = (row as unknown as { fields_json?: string }).fields_json;
        if (fieldsJson) rawFields['fields'] = JSON.parse(fieldsJson);
      } catch {
        // Malformed fields_json must not fail the whole detail read.
      }
      return { record: toRecord(row), rawFields };
    } finally {
      db.close();
    }
  }

  async getEvidence(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult> {
    const db = await this.openAndCheck(ctx);
    try {
      const projectId = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
      const row = db
        .prepare('SELECT project_id, detail_url, raw_text, html_sha256, content_sha256, fetched_at FROM trials WHERE project_id = ?')
        .get(projectId) as
        | { project_id: string; detail_url: string | null; raw_text: string | null; html_sha256: string | null; content_sha256: string | null; fetched_at: string | null }
        | undefined;
      if (!row) {
        throw new AdapterError('NO_RESULTS', 'RECORD_NOT_FOUND', `离线语料中不存在 project_id=${projectId} 的记录。`);
      }

      const maxChars = Math.max(0, Math.min(request.maxExcerptChars ?? 4000, 12_000));
      const kinds = request.evidenceKinds;
      const refs: EvidenceRef[] = [];
      const wants = (kind: EvidenceRef['kind']) => !kinds?.length || kinds.includes(kind);

      if (wants('raw_text') && row.raw_text) {
        refs.push({
          kind: 'raw_text',
          path: `sqlite:${this.descriptor.id}#trials/${projectId}/raw_text`,
          ...(row.detail_url ? { sourceUrl: row.detail_url } : {}),
          ...(row.content_sha256 ? { contentHash: row.content_sha256 } : {}),
          ...(row.fetched_at ? { capturedAt: row.fetched_at } : {}),
          excerpt: row.raw_text.slice(0, maxChars),
        });
      }
      if (wants('raw_html')) {
        refs.push({
          kind: 'raw_html',
          path: `sqlite:${this.descriptor.id}#trials/${projectId}/raw_html`,
          ...(row.detail_url ? { sourceUrl: row.detail_url } : {}),
          ...(row.html_sha256 ? { contentHash: row.html_sha256 } : {}),
          unavailableReason: '原始 HTML 保存在 SQLite 内，请通过 get_trial_detail 的 includeRawFields 读取。',
        });
      }
      return {
        refs,
        warnings: ['证据保存在只读离线语料内；未写入任何通用检索索引。'],
      };
    } finally {
      db.close();
    }
  }

  async getStatus(ctx: AdapterContext): Promise<SourceStatus> {
    const base: SourceStatus = {
      sourceId: this.descriptor.id,
      label: this.descriptor.label,
      enabled: this.descriptor.enabledByDefault,
      available: false,
      state: 'NEEDS_SETUP',
      reasonCode: 'CORPUS_NOT_CONFIGURED',
      explanation: '未配置离线语料路径。',
      freshness: { kind: this.descriptor.freshness },
      coverage: {
        scope: this.descriptor.scope,
        zeroResultMeaning: this.descriptor.zeroResultMeaning,
        indexOrArchiveOnly: true,
      },
    };
    try {
      const db = await this.openAndCheck(ctx);
      try {
        const meta = readCorpusMeta(db);
        const total = db.prepare('SELECT COUNT(*) AS c FROM trials').get() as { c: number } | undefined;
        const available: SourceStatus = {
          ...base,
          available: true,
          state: 'SUCCESS',
          reasonCode: 'OK',
          explanation: `离线语料可用，共 ${total?.c ?? 0} 条胰腺癌专题记录。`,
        };
        if (meta.fetchedAt) {
          available.freshness = { ...available.freshness, scrapedAt: meta.fetchedAt };
          const ageDays = (Date.now() - Date.parse(meta.fetchedAt)) / 86_400_000;
          if (!Number.isNaN(ageDays)) {
            available.freshness.staleAfterDays = this.descriptor.staleAfterDays;
            available.freshness.stale = ageDays > (this.descriptor.staleAfterDays ?? 90);
            if (available.freshness.stale) {
              available.explanation += ` 语料已 ${Math.round(ageDays)} 天未更新。`;
            }
          }
        }
        available.diagnostics = {
          records: total?.c ?? 0,
          detailFailures: meta.detailFailures,
          corpusPath: ctx.paths.chictrCorpus ?? '(unset)',
        };
        return available;
      } finally {
        db.close();
      }
    } catch (error) {
      if (error instanceof AdapterError) {
        const unavailable: SourceStatus = {
          ...base,
          state: error.state,
          reasonCode: error.reasonCode,
          explanation: error.message,
        };
        if (error.fixHint) unavailable.fixHint = error.fixHint;
        return unavailable;
      }
      return { ...base, state: 'FAILED', reasonCode: 'STATUS_CHECK_FAILED', explanation: (error as Error).message };
    }
  }

  async maintain(): Promise<never> {
    throw new AdapterError('NOT_ENABLED', 'READ_ONLY_ARCHIVE', '离线语料为只读资产，不支持维护操作。', {
      fixHint: '请使用该语料的采集工具更新文件后重新 configure。',
    });
  }
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

export function extractTerms(query: CanonicalQuery): string[] {
  const terms: string[] = [];
  const push = (value?: string) => {
    const trimmed = value?.trim();
    if (trimmed && !terms.includes(trimmed)) terms.push(trimmed);
  };
  push(query.keyword);
  push(query.condition);
  push(query.terms);
  for (const keyword of query.keywords ?? []) push(keyword);
  return terms;
}

function toRecord(row: TrialRow): RawSourceRecord {
  const registryNumbers = [];
  if (row.registration_number && row.registration_number.trim()) {
    registryNumbers.push({ registry: 'CHICTR', value: row.registration_number.trim(), primary: true });
  }
  const record: RawSourceRecord = {
    sourceRecordId: String(row.project_id),
    registryNumbers,
    rawFields: {},
  };
  if (row.title) record.title = row.title;
  if (row.disease) record.conditionOrDisease = [row.disease];
  if (row.study_type) record.studyType = row.study_type;
  if (row.recruitment_status) record.recruitmentStatus = row.recruitment_status.replace(/\s+/g, ' ').trim();
  const sponsors = [row.sponsor, row.institution].filter((v): v is string => Boolean(v && v.trim()));
  if (sponsors.length) record.sponsorOrInstitution = sponsors;
  if (row.detail_url) record.sourceUrl = row.detail_url;
  if (row.content_sha256) record.contentHash = row.content_sha256;
  const dates: NonNullable<RawSourceRecord['dates']> = {};
  if (row.registration_date) dates.registered = row.registration_date;
  if (row.updated_at) dates.updated = row.updated_at;
  if (Object.keys(dates).length) record.dates = dates;
  return record;
}

function readCorpusMeta(db: DatabaseSync): {
  fetchedAt?: string;
  detailFailures: number;
  unparsedYears: number[];
  events: Array<{ event: string; count: number }>;
} {
  const events = (db.prepare('SELECT event, COUNT(*) AS c FROM crawl_log GROUP BY event').all() as unknown as Array<{
    event: string;
    c: number;
  }>) ?? [];
  const maxAt = db.prepare('SELECT MAX(updated_at) AS m FROM trials').get() as { m: string | null } | undefined;

  const detailFailures = events
    .filter((entry) => /fail/i.test(entry.event))
    .reduce((sum, entry) => sum + Number(entry.c ?? 0), 0);

  const doneYears = new Set(
    (db.prepare("SELECT DISTINCT year FROM crawl_log WHERE event = 'crawl_done'").all() as unknown as Array<{ year: number | null }>)
      .map((row) => row.year)
      .filter((year): year is number => typeof year === 'number'),
  );
  const allYears = new Set(
    (db.prepare('SELECT DISTINCT source_year FROM trials').all() as unknown as Array<{ source_year: number | null }>)
      .map((row) => row.source_year)
      .filter((year): year is number => typeof year === 'number'),
  );
  const unparsedYears = [...allYears].filter((year) => !doneYears.has(year)).sort((a, b) => a - b);

  const meta: { fetchedAt?: string; detailFailures: number; unparsedYears: number[]; events: Array<{ event: string; count: number }> } = {
    detailFailures,
    unparsedYears,
    events: events.map((entry) => ({ event: entry.event, count: Number(entry.c ?? 0) })),
  };
  if (maxAt?.m) meta.fetchedAt = maxAt.m;
  return meta;
}

export const CHICTR_PANCREATIC_SOURCE_IDS = SOURCE_IDS;
