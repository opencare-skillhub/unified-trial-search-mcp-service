/**
 * ChiCTR online adapter (SPEC 6.2).
 *
 * ChiCTR is a WAF-protected site: the upstream MCP answers through a cache and
 * a Python sidecar, and occasionally lands in a CHALLENGED/COOLDOWN access
 * state. This adapter never attempts to bypass a challenge — it reports
 * `CHALLENGE_REQUIRED` (or `RATE_LIMITED` for cooldown) so the caller can see
 * that the source was NOT queried rather than reading an empty result.
 *
 * Upstream contract (`chictr-mcp-server`, tool `search_trials`):
 *   args: { keyword?, registration_number?, year?, max_results? }
 *   result envelope: content[0].text = JSON.stringify(results) where
 *     results is either TrialListItem[] or
 *     SidecarSearchResult { total: number|null, totalPages: number|null,
 *                           results: TrialListItem[] }
 *   TrialListItem = { registration_number, project_id, title, study_type,
 *                     registration_date, institution }
 *
 * `get_trial_detail` args: { registration_number } -> TrialDetail with nested
 * `basic_info`.
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
  type RawSourceRecord,
  type RegistryNumber,
  type SourceDescriptor,
  type SourceStatus,
} from '../core/types.js';
import { getDescriptor } from '../core/registry.js';
import { checkPathReadable } from '../core/config.js';
import { callUpstreamMcp } from '../core/mcp-transport.js';
import { readPackageEntry, resolveUpstreamEntry } from '../core/mcp-client.js';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** ChiCTR registration numbers look like `ChiCTR1800020401`. */
const REGISTRATION_PATTERN = /^ChiCTR\d{8,}$/i;

export class ChictrOnlineAdapter {
  readonly descriptor: SourceDescriptor;

  constructor() {
    this.descriptor = getDescriptor('chictr_online');
  }

  private async entry(ctx: AdapterContext): Promise<string | undefined> {
    const root = ctx.paths.chictrMcpServer;
    if (!root) return undefined;
    const direct = await resolveUpstreamEntry(root, ['dist/index.js', 'dist/src/index.js']);
    if (direct) return direct;
    return readPackageEntry(root);
  }

  private async requireEntry(ctx: AdapterContext): Promise<string> {
    const root = ctx.paths.chictrMcpServer;
    if (!root) {
      throw new AdapterError('NOT_ENABLED', 'CHICTR_ONLINE_NOT_CONFIGURED', '未配置 ChiCTR 在线服务目录。', {
        fixHint: '运行 configure --chictr-mcp-server <chictr_trials 目录>；离线语料请改用 chictr_pancreatic_archive。',
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
        'CHICTR_UPSTREAM_NOT_BUILT',
        `目录 ${root} 下未找到已构建的 ChiCTR MCP 入口（dist/index.js）。`,
        { fixHint: '在该目录运行 npm install && npm run build。' },
      );
    }
    return entry;
  }

  /**
   * Reads the upstream access state machine so a challenge/cooldown is reported
   * as an explicit non-query instead of an empty result. Best-effort: a failure
   * here must not mask the real search outcome.
   */
  private async accessState(entry: string, ctx: AdapterContext): Promise<string | undefined> {
    try {
      const outcome = await callUpstreamMcp({
        command: process.execPath,
        args: [entry],
        cwd: path.dirname(entry),
        toolName: 'get_access_state',
        toolArgs: {},
        timeoutMs: Math.min(ctx.timeoutMs, 5000),
        signal: ctx.signal,
        logger: ctx.logger,
        sourceId: this.descriptor.id,
      });
      const payload = asRecord(outcome.payload);
      return asString(payload?.['state']) ?? asString(payload?.['access_state']);
    } catch {
      return undefined;
    }
  }

  private challengeError(state: string | undefined): AdapterError | undefined {
    const normalized = (state ?? '').toUpperCase();
    if (normalized === 'CHALLENGED') {
      return new AdapterError(
        'CHALLENGE_REQUIRED',
        'CHICTR_CHALLENGE_REQUIRED',
        'ChiCTR 触发了人机验证；本服务不会绕过验证码。',
        { fixHint: '请人工在浏览器中完成验证（上游 prepare_verification_session），完成后重试；或改用离线胰腺癌语料。' },
      );
    }
    if (normalized === 'COOLDOWN') {
      return new AdapterError(
        'RATE_LIMITED',
        'CHICTR_COOLDOWN',
        'ChiCTR 访问处于冷却期，本次未发起检索。',
        { fixHint: '稍后重试；本服务不会提高请求频率或绕过限流。' },
      );
    }
    return undefined;
  }

  private toRecord(item: Record<string, unknown>): RawSourceRecord {
    const projectId = asString(item['project_id']);
    const registrationNumber = asString(item['registration_number']);
    if (!projectId && !registrationNumber) {
      throw new AdapterError(
        'FAILED',
        'MISSING_SOURCE_RECORD_ID',
        'ChiCTR 返回的记录既无 project_id 也无注册号，无法建立身份。',
      );
    }

    // project_id is the stable identity: 31 historic ChiCTR records have no
    // registration number at all, so registration_number can never be the key.
    const sourceRecordId = projectId ?? registrationNumber!;

    const registryNumbers: RegistryNumber[] = [];
    if (registrationNumber && REGISTRATION_PATTERN.test(registrationNumber)) {
      registryNumbers.push({ registry: 'CHICTR', value: registrationNumber, primary: true });
    }

    const record: RawSourceRecord = { sourceRecordId, registryNumbers };

    const title = asString(item['title']);
    if (title) record.title = title;
    const studyType = asString(item['study_type']);
    if (studyType) record.studyType = studyType;
    const institution = asString(item['institution']);
    if (institution) record.sponsorOrInstitution = [institution];
    const registrationDate = asString(item['registration_date']);
    if (registrationDate) record.dates = { registered: registrationDate };

    const detailUrl = asString(item['detail_url']);
    if (detailUrl) record.sourceUrl = detailUrl;
    else if (projectId) record.sourceUrl = `https://www.chictr.org.cn/showproj.html?proj=${encodeURIComponent(projectId)}`;

    return record;
  }

  async search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const entry = await this.requireEntry(ctx);

    const maxResults = Math.max(1, Math.min(query.limit ?? 20, this.descriptor.maxResults));
    const toolArgs: Record<string, unknown> = { max_results: maxResults };

    const keyword = query.keyword?.trim() || query.terms?.trim() || query.condition?.trim();
    if (keyword) toolArgs['keyword'] = keyword;
    else if (query.keywords?.length) toolArgs['keyword'] = query.keywords.join(' ');

    // A caller-supplied ChiCTR registration number becomes a precise lookup.
    const explicit = query as CanonicalQuery & { registrationNumber?: string };
    const registrationNumber = explicit.registrationNumber?.trim();
    if (registrationNumber) toolArgs['registration_number'] = registrationNumber;

    if (!toolArgs['keyword'] && !registrationNumber) {
      throw new AdapterError(
        'FAILED',
        'CHICTR_QUERY_REQUIRED',
        'ChiCTR 需要关键词或注册号；本适配器不会以空条件拉取全量列表。',
      );
    }

    const preState = await this.accessState(entry, ctx);
    const blocked = this.challengeError(preState);
    if (blocked) throw blocked;

    const outcome = await callUpstreamMcp({
      command: process.execPath,
      args: [entry],
      cwd: path.dirname(entry),
      toolName: 'search_trials',
      toolArgs,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      logger: ctx.logger,
      sourceId: this.descriptor.id,
    });

    // The upstream returns either a bare array or a sidecar envelope.
    const payload = outcome.payload;
    let items: unknown[];
    let upstreamTotal: number | undefined;
    let totalPages: number | undefined;

    if (Array.isArray(payload)) {
      items = payload;
    } else {
      const envelope = asRecord(payload);
      const nested = envelope?.['results'];
      if (!Array.isArray(nested)) {
        throw new AdapterError(
          'FAILED',
          'UPSTREAM_ENVELOPE_UNRECOGNISED',
          'ChiCTR 响应既不是数组也不含 results 数组；本服务不会把无法解析的响应当作零结果。',
        );
      }
      items = nested;
      if (typeof envelope?.['total'] === 'number') upstreamTotal = envelope['total'] as number;
      if (typeof envelope?.['totalPages'] === 'number') totalPages = envelope['totalPages'] as number;
    }

    const records: RawSourceRecord[] = [];
    const warnings: string[] = [];
    for (const item of items) {
      const record = asRecord(item);
      if (!record) continue;
      try {
        records.push(this.toRecord(record));
      } catch (error) {
        warnings.push((error as Error).message);
      }
    }

    if (totalPages !== undefined && totalPages > 1) {
      warnings.push(`上游报告共有 ${totalPages} 页结果，本服务只取回首页 ${records.length} 条；如需更全请缩小检索词。`);
    }

    const result: AdapterSearchResult = {
      records,
      rowsReturned: upstreamTotal ?? records.length,
      recordsIncomplete: upstreamTotal !== undefined && upstreamTotal > records.length,
      truncated: upstreamTotal !== undefined && upstreamTotal > records.length,
      warnings,
      retrievedAt: new Date().toISOString(),
    };
    if (upstreamTotal !== undefined) result.upstreamReportedTotal = upstreamTotal;
    result.coverage = { totalPages: totalPages ?? null, upstreamTotal: upstreamTotal ?? null };
    return result;
  }

  async getDetail(id: string, ctx: AdapterContext): Promise<AdapterDetailResult> {
    const raw = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const entry = await this.requireEntry(ctx);

    // Detail requires a registration number; when the caller passed a
    // project_id we first resolve it through search.
    let registrationNumber = REGISTRATION_PATTERN.test(raw) ? raw : undefined;
    if (!registrationNumber) {
      const searched = await this.search(
        { keywords: [raw], limit: 20 } as CanonicalQuery,
        ctx,
      );
      // No fallback to `records[0]`. Taking the first hit of a keyword search
      // when no record matches the requested id returns a DIFFERENT trial's
      // detail while reporting success - the caller has no way to tell. In a
      // clinical context a confidently wrong record is worse than "not found".
      const match = searched.records.find((record) => record.sourceRecordId === raw);
      const found = match?.registryNumbers?.find((number) => number.registry === 'CHICTR');
      if (!found) {
        throw new AdapterError(
          'NO_RESULTS',
          'RECORD_NOT_FOUND',
          `无法从 project_id=${raw} 解析出 ChiCTR 注册号，无法获取详情。`,
        );
      }
      registrationNumber = found.value;
    }

    const outcome = await callUpstreamMcp({
      command: process.execPath,
      args: [entry],
      cwd: path.dirname(entry),
      toolName: 'get_trial_detail',
      toolArgs: { registration_number: registrationNumber },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      logger: ctx.logger,
      sourceId: this.descriptor.id,
    });

    const payload = asRecord(outcome.payload);
    if (!payload) {
      throw new AdapterError('FAILED', 'UPSTREAM_ENVELOPE_UNRECOGNISED', 'ChiCTR 详情响应不是对象。');
    }
    if (payload['error']) {
      // An upstream `error` field is not evidence that the record is absent. It
      // is equally what an expired session, a throttle or a WAF page returns,
      // and NO_RESULTS asserts "queried, genuinely nothing matched" - which
      // would turn an upstream failure into a claim of absence. FAILED states
      // only what is actually known.
      throw new AdapterError(
        'FAILED',
        'CHICTR_DETAIL_UPSTREAM_ERROR',
        `ChiCTR 详情查询返回错误：${String(payload['error'])}`,
        { fixHint: '运行 doctor 检查 ChiCTR 在线来源的运行时与会话状态；若持续失败请稍后重试。' },
      );
    }

    const basicInfo = asRecord(payload['basic_info']) ?? payload;
    const projectId = asString(payload['project_id']) ?? asString(basicInfo['project_id']);
    const sourceRecordId = projectId ?? registrationNumber;

    const registryNumbers: RegistryNumber[] = [
      { registry: 'CHICTR', value: registrationNumber, primary: true },
    ];
    const record: RawSourceRecord = {
      sourceRecordId,
      registryNumbers,
      sourceUrl: projectId
        ? `https://www.chictr.org.cn/showproj.html?proj=${encodeURIComponent(projectId)}`
        : `https://www.chictr.org.cn/showproj.html?proj=${encodeURIComponent(registrationNumber)}`,
    };

    const title = asString(basicInfo['title']) ?? asString(basicInfo['scientific_title']);
    if (title) record.title = title;
    const titleEn = asString(basicInfo['title_en']) ?? asString(basicInfo['scientific_title_en']);
    if (titleEn) record.publicTitle = titleEn;
    const status = asString(basicInfo['registration_status']);
    if (status) record.recruitmentStatus = status;
    const registered = asString(basicInfo['registration_date']);
    const updated = asString(basicInfo['last_update_date']);
    if (registered || updated) {
      record.dates = {};
      if (registered) record.dates.registered = registered;
      if (updated) record.dates.updated = updated;
    }

    return { record, rawFields: payload, warnings: [] };
  }

  async getEvidence(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult> {
    const raw = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const refs: EvidenceRef[] = [];
    let detail: AdapterDetailResult | undefined;
    try {
      detail = await this.getDetail(id, ctx);
    } catch (error) {
      refs.push({
        kind: 'field_excerpt',
        path: `chictr_online:${raw}`,
        unavailableReason: (error as Error).message,
      });
    }

    if (detail) {
      refs.push({
        kind: 'field_excerpt',
        path: `chictr_online:${detail.record.sourceRecordId}`,
        excerpt: JSON.stringify(detail.rawFields).slice(0, request.maxExcerptChars ?? 4000),
        sourceUrl: detail.record.sourceUrl,
        capturedAt: new Date().toISOString(),
      });
    }

    // The upstream's local cache is evidence only when configured locally; it is
    // never the corpus, so it is always labelled as a cache pointer.
    const root = ctx.paths.chictrMcpServer;
    if (root) {
      const cacheDir = path.join(root, '.cache');
      try {
        await fs.access(cacheDir);
        refs.push({
          kind: 'source_json',
          path: cacheDir,
          unavailableReason: 'ChiCTR 上游缓存不构成语料库，仅作原始抓取证据指针；离线语料请用 chictr_pancreatic_archive。',
        });
      } catch {
        // No cache directory: nothing to point at.
      }
    }

    return { refs, warnings: [] };
  }

  async getStatus(ctx: AdapterContext): Promise<SourceStatus> {
    const base: SourceStatus = {
      sourceId: this.descriptor.id,
      label: this.descriptor.label,
      enabled: this.descriptor.enabledByDefault,
      available: false,
      state: 'NOT_ENABLED',
      reasonCode: 'CHICTR_ONLINE_NOT_CONFIGURED',
      explanation: '未配置 ChiCTR 在线服务目录；离线胰腺癌语料仍可独立使用。',
      freshness: { kind: this.descriptor.freshness },
      coverage: {
        scope: this.descriptor.scope,
        zeroResultMeaning: this.descriptor.zeroResultMeaning,
        indexOrArchiveOnly: false,
      },
    };

    const root = ctx.paths.chictrMcpServer;
    if (!root) return base;
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        return { ...base, state: 'NEEDS_SETUP', reasonCode: 'CHICTR_MCP_NOT_A_DIR', explanation: `配置的 ChiCTR 路径不是目录：${root}` };
      }
    } catch {
      return {
        ...base,
        state: 'NEEDS_SETUP',
        reasonCode: 'CHICTR_MCP_MISSING',
        explanation: `配置的 ChiCTR 服务目录不存在：${root}`,
      };
    }

    const entry = await this.entry(ctx);
    if (!entry) {
      return {
        ...base,
        state: 'NEEDS_SETUP',
        reasonCode: 'CHICTR_UPSTREAM_NOT_BUILT',
        explanation: `未找到已构建的 ChiCTR MCP 入口（${path.join(root, 'dist/index.js')}）。`,
        fixHint: '在该目录运行 npm install && npm run build。',
      };
    }

    const state = await this.accessState(entry, ctx);
    const blocked = this.challengeError(state);
    if (blocked) {
      return {
        ...base,
        available: false,
        state: blocked.state,
        reasonCode: blocked.reasonCode,
        explanation: blocked.message,
        fixHint: blocked.fixHint,
        diagnostics: { entry, accessState: state },
      };
    }

    return {
      ...base,
      available: true,
      state: 'SUCCESS',
      reasonCode: 'OK',
      explanation: 'ChiCTR 在线入口可用；检索受上游缓存与访问限流约束。',
      diagnostics: { entry, accessState: state ?? 'UNKNOWN' },
    };
  }
}
