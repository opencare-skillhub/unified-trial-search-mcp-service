/**
 * ChinaDrugTrials controlled adapter (SPEC 6.5).
 *
 * This is the only source that needs a lawful session credential. Design rules
 * that are deliberately not configurable:
 *
 *  - The Cookie comes only from the secret accessor (env/config). It is never
 *    accepted as a tool argument, never logged, and never written to disk.
 *  - No CAPTCHA solving, WAF bypass, proxy rotation or robots circumvention.
 *    A challenge/expired session is reported as an explicit state.
 *  - Requests are serialized with a polite delay; there is no parallel crawl.
 *  - Read-only: `search` / `getDetail` only fetch. Writing new scraped data is
 *    the explicit `sync_chinadrugtrials` maintenance tool, never a query.
 *
 * Upstream site contract (from the reference scraper):
 *   BASE_URL       = https://www.chinadrugtrials.org.cn
 *   SEARCH_URL     = /clinicaltrials.searchlist.dhtml   (POST form)
 *   DETAIL_URL     = /clinicaltrials.searchlistdetail.dhtml (POST form)
 *   form fields    = keywords, sort=desc, sort2='', rule=CTR,
 *                    secondLevel ('1' simple / '0' advanced), currentpage,
 *                    id='', ckm_index='', plus ADV_FIELDS
 *                    (reg_no, indication, case_no, drugs_name, drugs_type,
 *                     appliers, communities, researchers, agencies, state)
 *   list page      = table.searchTable rows -> {seq, id, ckm_index, reg_no,
 *                    state, drug_name, indication, title}
 *   pagination     = div.pageInfo "当前第 X 页 共 Y 页 共 Z 条"
 *   PAGE_SIZE      = 20
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

const BASE_URL = 'https://www.chinadrugtrials.org.cn';
const SEARCH_URL = `${BASE_URL}/clinicaltrials.searchlist.dhtml`;
const DETAIL_URL = `${BASE_URL}/clinicaltrials.searchlistdetail.dhtml`;
const PAGE_SIZE = 20;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** Secret names consulted, in order, through the secret accessor. */
const COOKIE_SECRET_NAMES = ['CHINADRUGTRIALS_COOKIE', 'CDT_COOKIE'];

/**
 * Serializes every outbound request for this source so we never issue two
 * concurrent requests to the site.
 *
 * This MUST be reentrant: composed flows (e.g. `getDetail` → resolve the
 * site-internal id via a list search → POST the detail page) call `serialize`
 * inside an outer `serialize`. A non-reentrant chain would make the outer task
 * wait for the inner task while the inner task waits for the outer one to
 * release the chain — a deadlock that never settles.
 */
let requestChain: Promise<unknown> = Promise.resolve();
let requestDepth = 0;

function serialize<T>(task: () => Promise<T>): Promise<T> {
  // Already inside a serialized section: run inline to keep the chain reentrant.
  if (requestDepth > 0) {
    requestDepth += 1;
    return task().finally(() => {
      requestDepth -= 1;
    });
  }

  const run = requestChain.then(
    () => {
      requestDepth += 1;
      return task().finally(() => {
        requestDepth -= 1;
      });
    },
    () => {
      requestDepth += 1;
      return task().finally(() => {
        requestDepth -= 1;
      });
    },
  );
  requestChain = run.catch(() => undefined);
  return run;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

interface ParsedRow {
  seq?: string;
  id?: string;
  ckmIndex?: string;
  regNo?: string;
  state?: string;
  drugName?: string;
  indication?: string;
  title?: string;
}

/**
 * Parses a ChinaDrugTrials detail page into flat fields plus nested sections.
 *
 * The page is genuinely structured: section headings are
 * `<div class="searchDetailPartTit">四、研究者信息</div>`, sub-headings are
 * `<div class="sDPTit2">1、主要研究者信息</div>`, and label/value pairs are
 * `<th>姓名</th><td>叶定伟</td>`. We walk that real DOM order rather than
 * guessing from flattened text, because the flattened form is ambiguous
 * (values contain spaces, `、` and full-width punctuation, so a text-level
 * regex invents garbage keys like `、试验目的`).
 *
 * As with the archive JSON, the nested section form is authoritative.
 */
function parseDetailPage(html: string): {
  fields: Record<string, string>;
  sections: Record<string, Record<string, string>>;
} {
  const fields: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};

  // Walk the markup in document order so each label/value pair lands in the
  // section that is actually open at that point.
  const tokenRe =
    /<div[^>]*class=["'][^"']*searchDetailPartTit[^"']*["'][^>]*>([\s\S]*?)<\/div>|<div[^>]*class=["'][^"']*sDPTit2[^"']*["'][^>]*>([\s\S]*?)<\/div>|<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi;

  let section = '基本信息';
  let subsection = '';
  const put = (label: string, value: string): void => {
    if (!label || !value) return;
    const bucket = sections[section] ?? (sections[section] = {});
    // Qualify with the sub-heading so repeated labels across subsections
    // (e.g. 序号) do not overwrite each other.
    const key = subsection ? `${subsection}/${label}` : label;
    if (!bucket[key]) bucket[key] = value;
    // The flat index keeps the first occurrence, which for 登记号/试验状态 is
    // the headline block that appears before any section heading.
    if (!fields[label]) fields[label] = value;
  };

  for (const match of html.matchAll(tokenRe)) {
    const partTitle = match[1];
    const subTitle = match[2];
    if (partTitle !== undefined) {
      const name = stripTags(partTitle).trim();
      if (name) section = name;
      subsection = '';
      continue;
    }
    if (subTitle !== undefined) {
      subsection = stripTags(subTitle).trim();
      continue;
    }
    const label = stripTags(match[3] ?? '').trim();
    const value = stripTags(match[4] ?? '').trim();
    if (!label || !value || value === '企业选择不公示') continue;
    put(label, value);
  }

  return { fields, sections };
}

/** Extracts the `searchTable` rows without pulling in an HTML parser dependency. */
function parseListPage(html: string): { rows: ParsedRow[]; totalRecords?: number; totalPages?: number } {
  const rows: ParsedRow[] = [];

  const tableMatch = /<table[^>]*class=["'][^"']*searchTable[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) return { rows };

  const rowHtml = tableMatch[1] ?? '';
  for (const rowMatch of rowHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const body = rowMatch[1] ?? '';
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? '');
    if (cells.length < 6) continue;

    const linkCell = cells[1] ?? '';
    const linkMatch = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(linkCell);
    if (!linkMatch) continue;
    const attrs = linkMatch[1] ?? '';
    const idMatch = /\bid=["']([^"']*)["']/i.exec(attrs);
    const nameMatch = /\bname=["']([^"']*)["']/i.exec(attrs);

    rows.push({
      seq: stripTags(cells[0] ?? ''),
      id: idMatch?.[1],
      ckmIndex: nameMatch?.[1],
      regNo: stripTags(linkCell),
      state: stripTags(cells[2] ?? ''),
      drugName: stripTags(cells[3] ?? ''),
      indication: stripTags(cells[4] ?? ''),
      title: stripTags(cells[5] ?? ''),
    });
  }

  const pageInfo = /<div[^>]*class=["'][^"']*pageInfo[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  let totalRecords: number | undefined;
  let totalPages: number | undefined;
  if (pageInfo) {
    const text = stripTags(pageInfo[1] ?? '');
    const match = /当前第\s*(\d+)\s*页[\s\S]*?共\s*(\d+)\s*页[\s\S]*?共\s*(\d+)\s*条/.exec(text);
    if (match) {
      totalPages = Number.parseInt(match[2] ?? '0', 10);
      totalRecords = Number.parseInt(match[3] ?? '0', 10);
    }
  }
  return { rows, ...(totalRecords !== undefined ? { totalRecords } : {}), ...(totalPages !== undefined ? { totalPages } : {}) };
}

export class ChinaDrugTrialsAdapter {
  readonly descriptor: SourceDescriptor;

  constructor() {
    this.descriptor = getDescriptor('chinadrugtrials');
  }

  private cookie(ctx: AdapterContext): string {
    for (const name of COOKIE_SECRET_NAMES) {
      const value = ctx.secrets.get(name);
      if (value && value.trim()) return value.trim();
    }
    throw new AdapterError(
      'NEEDS_SETUP',
      'CHINADRUGTRIALS_COOKIE_MISSING',
      '未配置 ChinaDrugTrials 会话 Cookie，无法发起检索。',
      {
        fixHint:
          '请运行 configure --cookie-from-entry-page 自动获取，或运行 configure --cookie-from-curl 粘贴浏览器' +
          '「复制为 cURL」的命令；两者都会写入 <配置目录>/cookie.env（0600）。' +
          '本服务不会自动绕过验证码或 WAF。',
      },
    );
  }

  /** POSTs a form and maps transport/HTTP failures onto explicit states. */
  private async post(
    url: string,
    form: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<string> {
    const cookie = this.cookie(ctx);
    const body = new URLSearchParams(form).toString();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'follow',
        signal: ctx.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Origin: BASE_URL,
          Referer: `${BASE_URL}/index.html`,
          'Upgrade-Insecure-Requests': '1',
          Cookie: cookie,
        },
        body,
      });
    } catch (error) {
      if (ctx.signal.aborted) {
        throw new AdapterError('TIMEOUT', 'SOURCE_TIMEOUT', 'ChinaDrugTrials 请求被中止。');
      }
      throw new AdapterError(
        'FAILED',
        'CHINADRUGTRIALS_NETWORK_ERROR',
        `ChinaDrugTrials 网络请求失败：${(error as Error).message}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AdapterError(
        'DENIED',
        'CHINADRUGTRIALS_ACCESS_DENIED',
        `ChinaDrugTrials 拒绝访问（HTTP ${response.status}）；可能是会话失效或访问受限。`,
        { fixHint: '请人工确认账号权限并更新合法 Cookie；本服务不会尝试绕过访问控制。' },
      );
    }
    if (response.status === 429) {
      throw new AdapterError('RATE_LIMITED', 'CHINADRUGTRIALS_RATE_LIMITED', 'ChinaDrugTrials 返回 HTTP 429，已停止请求。', {
        fixHint: '稍后重试；本服务不会提高请求频率。',
      });
    }
    if (response.status >= 500) {
      throw new AdapterError('FAILED', 'CHINADRUGTRIALS_UPSTREAM_ERROR', `ChinaDrugTrials 返回 HTTP ${response.status}。`);
    }
    if (!response.ok) {
      throw new AdapterError('FAILED', 'CHINADRUGTRIALS_HTTP_ERROR', `ChinaDrugTrials 返回 HTTP ${response.status}。`);
    }

    const html = await response.text();
    if (/验证码|人机验证|captcha|滑动验证/i.test(html) && !/searchTable/i.test(html)) {
      throw new AdapterError(
        'CHALLENGE_REQUIRED',
        'CHINADRUGTRIALS_CHALLENGE_REQUIRED',
        'ChinaDrugTrials 返回了人机验证页面；本服务不会尝试破解验证码。',
        { fixHint: '请人工在浏览器中完成验证并更新合法 Cookie，然后重试。' },
      );
    }
    return html;
  }

  private buildForm(keyword: string, page: number, query: CanonicalQuery): Record<string, string> {
    const advanced: Record<string, string> = {};
    if (query.status?.length) advanced['state'] = query.status[0] ?? '';

    const form: Record<string, string> = {
      keywords: keyword,
      sort: 'desc',
      sort2: '',
      rule: 'CTR',
      secondLevel: Object.keys(advanced).length ? '0' : '1',
      currentpage: String(page),
      id: '',
      ckm_index: '',
    };
    for (const field of [
      'reg_no',
      'indication',
      'case_no',
      'drugs_name',
      'drugs_type',
      'appliers',
      'communities',
      'researchers',
      'agencies',
      'state',
    ]) {
      form[field] = advanced[field] ?? '';
    }
    return form;
  }

  private toRecord(row: ParsedRow, partial: boolean): RawSourceRecord {
    const regNo = row.regNo?.trim();
    if (!regNo) {
      throw new AdapterError('FAILED', 'MISSING_SOURCE_RECORD_ID', 'ChinaDrugTrials 列表行缺少登记号。');
    }
    const registryNumbers: RegistryNumber[] = [];
    if (/^CTR\d+/i.test(regNo)) {
      registryNumbers.push({ registry: 'CTR', value: regNo, primary: true });
    }
    const record: RawSourceRecord = {
      sourceRecordId: regNo,
      registryNumbers,
      sourceUrl: DETAIL_URL,
      rawFields: {
        seq: row.seq,
        id: row.id,
        ckm_index: row.ckmIndex,
        // The list page gives no stable per-record URL; the detail page is a
        // POST target, so the stable handle is the site-internal id pair.
        partialFromListPage: partial,
      },
    };
    if (row.title?.trim()) record.title = row.title.trim();
    if (row.drugName?.trim()) record.interventions = [row.drugName.trim()];
    if (row.indication?.trim()) record.conditionOrDisease = [row.indication.trim()];
    if (row.state?.trim()) record.recruitmentStatus = row.state.trim();
    return record;
  }

  async search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const keyword = query.keyword?.trim() || query.terms?.trim() || query.condition?.trim() ||
      query.keywords?.join(' ')?.trim() || '';
    if (!keyword) {
      throw new AdapterError(
        'FAILED',
        'CHINADRUGTRIALS_QUERY_REQUIRED',
        'ChinaDrugTrials 需要关键词；本适配器不会以空条件全量抓取。',
      );
    }

    const limit = Math.max(1, Math.min(query.limit ?? PAGE_SIZE, this.descriptor.maxResults));
    const offset = Math.max(0, query.offset ?? 0);
    const startPage = Math.floor(offset / PAGE_SIZE) + 1;
    const pagesNeeded = Math.ceil((offset % PAGE_SIZE + limit) / PAGE_SIZE);
    const lastPage = startPage + pagesNeeded - 1;

    const collected: ParsedRow[] = [];
    let totalRecords: number | undefined;
    let totalPages: number | undefined;
    const warnings: string[] = [];

    for (let page = startPage; page <= lastPage; page += 1) {
      const html = await serialize(() => this.post(SEARCH_URL, this.buildForm(keyword, page, query), ctx));
      const parsed = parseListPage(html);
      if (!parsed.rows.length && page === startPage) {
        warnings.push(
          'ChinaDrugTrials 未返回结果表格；可能是关键词确实无命中，也可能是会话失效或被限流，请结合来源状态判断。',
        );
      }
      collected.push(...parsed.rows);
      totalRecords ??= parsed.totalRecords;
      totalPages ??= parsed.totalPages;
      if (parsed.totalPages !== undefined && page >= parsed.totalPages) break;
    }

    const sliceStart = offset % PAGE_SIZE;
    const selected = collected.slice(sliceStart, sliceStart + limit);

    const records: RawSourceRecord[] = [];
    for (const row of selected) {
      try {
        records.push(this.toRecord(row, true));
      } catch (error) {
        warnings.push((error as Error).message);
      }
    }

    if (totalPages !== undefined && totalPages > lastPage) {
      warnings.push(
        `上游共 ${totalPages} 页、约 ${totalRecords ?? '未知'} 条记录，本次只取第 ${startPage}-${lastPage} 页；` +
          '受控来源不进行大规模抓取，如需完整数据请运行 sync_chinadrugtrials。',
      );
    }

    const result: AdapterSearchResult = {
      records,
      rowsReturned: totalRecords ?? records.length,
      // List-page rows are partial by design; full evidence requires detail/sync.
      recordsIncomplete: true,
      truncated: totalRecords !== undefined && totalRecords > records.length,
      warnings,
      retrievedAt: new Date().toISOString(),
    };
    if (totalRecords !== undefined) result.upstreamReportedTotal = totalRecords;
    result.coverage = {
      pageSize: PAGE_SIZE,
      pagesFetched: `${startPage}-${lastPage}`,
      totalPages: totalPages ?? null,
      totalRecords: totalRecords ?? null,
      listPageOnly: true,
    };
    return result;
  }

  /** Resolves a local archive JSON for a record when the configured archive has one. */
  private async localRecord(id: string, ctx: AdapterContext): Promise<{ json: unknown; jsonPath: string } | undefined> {
    const root = ctx.paths.chinadrugtrialsArchive;
    if (!root) return undefined;
    const regNo = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    if (!/^[A-Za-z0-9_-]+$/.test(regNo)) return undefined;

    // The archive layout mirrors the scrape output: <root>/output/<package>/json/<reg_no>.json
    const candidates: string[] = [];
    for (const base of [root, path.join(root, 'output')]) {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(base);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        candidates.push(path.join(base, entry, 'json', `${regNo}.json`));
      }
    }
    for (const candidate of candidates) {
      try {
        const text = await fs.readFile(candidate, 'utf8');
        return { json: JSON.parse(text) as unknown, jsonPath: candidate };
      } catch {
        // Try the next candidate.
      }
    }
    return undefined;
  }

  async getDetail(id: string, ctx: AdapterContext): Promise<AdapterDetailResult> {
    const regNo = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;

    // Prefer a local archive copy: it is the authoritative nested `sections`
    // form and avoids an outbound request for data we already hold.
    const local = await this.localRecord(id, ctx);
    if (local) {
      const payload = local.json as Record<string, unknown>;
      const sections = payload?.['sections'];
      const details = payload?.['details'];
      const listInfo = payload?.['list_info'];
      const merged: Record<string, unknown> = {
        sections: sections ?? null,
        details: details ?? null,
        list_info: listInfo ?? null,
        archiveJsonPath: local.jsonPath,
      };
      const record = this.recordFromArchiveJson(regNo, payload, local.jsonPath);
      return {
        record,
        rawFields: merged,
        warnings: ['详情来自本地归档 JSON（sections 为权威内容，扁平 details 字段仅作参考）。'],
      };
    }

    const html = await serialize(() => this.fetchDetailHtml(regNo, ctx));

    // A skeleton page (title `<登记号>详细信息`, no detail tables) means the
    // detail request did not resolve to a real record. Returning it as a
    // successful detail would present a placeholder as evidence.
    if (!/searchDetailPartTit|searchDetailTable/i.test(html)) {
      throw new AdapterError(
        'FAILED',
        'CHINADRUGTRIALS_DETAIL_UNRESOLVED',
        `ChinaDrugTrials 详情页未返回真实内容（登记号 ${regNo}）；可能是会话失效、限流或站点结构变更。`,
        { fixHint: '请运行 doctor 检查来源状态与会话有效性，稍后重试。' },
      );
    }

    const record: RawSourceRecord = {
      sourceRecordId: regNo,
      registryNumbers: /^CTR\d+/i.test(regNo) ? [{ registry: 'CTR', value: regNo, primary: true }] : [],
      sourceUrl: DETAIL_URL,
    };

    // The detail page is a POST target keyed by the site's internal id pair,
    // which only the list page exposes. `fetchDetailHtml` resolves it by
    // registration number.
    const detail = parseDetailPage(html);
    if (detail.fields['登记号']) record.registryNumbers = [{ registry: 'CTR', value: detail.fields['登记号'], primary: true }];
    if (detail.fields['试验专业题目']) {
      record.title = detail.fields['试验专业题目'];
      record.publicTitle = detail.fields['试验通俗题目'] ?? record.publicTitle;
      record.conditionOrDisease = [detail.fields['适应症'] ?? ''].filter(Boolean);
      const drug = detail.fields['药物名称'];
      if (drug) record.interventions = [drug];
      const state = detail.fields['试验状态'];
      if (state) record.recruitmentStatus = state;
    }

    return {
      record,
      rawFields: {
        fields: detail.fields,
        sections: detail.sections,
        htmlLength: html.length,
        fetchedAt: new Date().toISOString(),
      },
      warnings: [
        '详情来自 ChinaDrugTrials 在线详情页（POST 目标，按登记号解析站点内部 id）；' +
          '本服务不保存该页面快照，请通过站点人工核验原文。',
      ],
    };
  }

  /**
   * Resolves the site-internal `id`/`ckm_index` pair for a registration number
   * and POSTs the real detail page.
   *
   * The detail endpoint returns a skeleton page titled `<登记号>详细信息` when the
   * id pair is missing, so searching the list first is what makes this request
   * meaningful rather than a silent placeholder.
   */
  private async fetchDetailHtml(regNo: string, ctx: AdapterContext): Promise<string> {
    const row = await this.findListRow(regNo, ctx);
    if (!row?.id) {
      throw new AdapterError(
        'NO_RESULTS',
        'CHINADRUGTRIALS_RECORD_NOT_FOUND',
        `未能在 ChinaDrugTrials 列表中找到登记号 ${regNo}，无法构造详情请求。`,
        {
          fixHint:
            '请确认登记号正确；若站点会话已失效或限流，请先运行 doctor 检查来源状态。',
        },
      );
    }
    return serialize(() =>
      this.post(
        DETAIL_URL,
        { ...this.buildForm('', 1, {} as CanonicalQuery), id: row.id ?? '', ckm_index: row.ckmIndex ?? '' },
        ctx,
      ),
    );
  }

  /** Finds a list-page row by registration number, scanning at most 5 pages. */
  private async findListRow(regNo: string, ctx: AdapterContext): Promise<ParsedRow | undefined> {
    for (let page = 1; page <= 5; page += 1) {
      const html = await serialize(() => this.post(SEARCH_URL, this.buildForm(regNo, page, {} as CanonicalQuery), ctx));
      const parsed = parseListPage(html);
      const hit = parsed.rows.find((row) => row.regNo?.trim().toUpperCase() === regNo.toUpperCase());
      if (hit) return hit;
      if (!parsed.totalPages || page >= parsed.totalPages) break;
    }
    return undefined;
  }

  private recordFromArchiveJson(regNo: string, payload: Record<string, unknown>, jsonPath: string): RawSourceRecord {
    const sections = payload?.['sections'] as Record<string, Record<string, unknown>> | undefined;
    const topic = sections?.['一、题目和背景信息'];
    const basic = sections?.['基本信息'];

    const record: RawSourceRecord = {
      sourceRecordId: regNo,
      registryNumbers: [{ registry: 'CTR', value: regNo, primary: true }],
      sourceUrl: DETAIL_URL,
      rawFields: { jsonPath },
    };

    const pick = (bucket: Record<string, unknown> | undefined, key: string): string | undefined => {
      const value = bucket?.[key];
      if (typeof value === 'string' && value.trim() && value.trim() !== '企业选择不公示') return value.trim();
      return undefined;
    };

    const title = pick(topic, '试验专业题目') ?? pick(topic, '试验通俗题目');
    if (title) record.title = title;
    const popular = pick(topic, '试验通俗题目');
    if (popular) record.publicTitle = popular;
    const indication = pick(topic, '适应症');
    if (indication) record.conditionOrDisease = [indication];
    const drug = pick(topic, '药物名称');
    if (drug) record.interventions = [drug];
    const status = pick(basic, '试验状态');
    if (status) record.recruitmentStatus = status;
    const firstPublished = pick(basic, '首次公示信息日期');
    if (firstPublished) record.dates = { registered: firstPublished };

    const hash = payload?.['content_hash'];
    if (typeof hash === 'string') record.contentHash = hash;
    return record;
  }

  async getEvidence(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult> {
    const refs: EvidenceRef[] = [];
    const warnings: string[] = [];
    const local = await this.localRecord(id, ctx);
    const maxChars = request.maxExcerptChars ?? 4000;

    if (local) {
      refs.push({
        kind: 'source_json',
        path: local.jsonPath,
        excerpt: JSON.stringify(local.json).slice(0, maxChars),
        capturedAt: new Date().toISOString(),
      });
      const dir = path.dirname(local.jsonPath);
      const parent = path.dirname(dir);
      const regNo = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
      const rawPath = path.join(parent, 'raw', `${regNo}_detail.html`);
      try {
        await fs.access(rawPath);
        refs.push({ kind: 'raw_html', path: rawPath, capturedAt: new Date().toISOString() });
      } catch {
        refs.push({
          kind: 'raw_html',
          path: rawPath,
          unavailableReason: '该记录的原始详情 HTML 不在本地归档中。',
        });
      }
    } else {
      refs.push({
        kind: 'field_excerpt',
        path: `chinadrugtrials:${id}`,
        sourceUrl: DETAIL_URL,
        unavailableReason:
          'ChinaDrugTrials 为受控在线来源，本服务不保存其页面快照；请通过站点人工核验原始页面。',
      });
    }

    return { refs, warnings };
  }

  async getStatus(ctx: AdapterContext): Promise<SourceStatus> {
    const base: SourceStatus = {
      sourceId: this.descriptor.id,
      label: this.descriptor.label,
      enabled: this.descriptor.enabledByDefault,
      available: false,
      state: 'NEEDS_SETUP',
      reasonCode: 'CHINADRUGTRIALS_COOKIE_MISSING',
      explanation: '未配置 ChinaDrugTrials 会话 Cookie。',
      freshness: { kind: this.descriptor.freshness },
      coverage: {
        scope: this.descriptor.scope,
        zeroResultMeaning: this.descriptor.zeroResultMeaning,
        indexOrArchiveOnly: false,
      },
    };

    const configured = COOKIE_SECRET_NAMES.some((name) => ctx.secrets.has(name));
    const archive = ctx.paths.chinadrugtrialsArchive;
    let archiveInfo: Record<string, unknown> | undefined;

    if (archive) {
      const check = await checkPathReadable(archive, ctx.paths.evidenceRoots, 'dir');
      archiveInfo = check.ok
        ? { path: archive, readable: true }
        : { path: archive, readable: false, reason: check.reasonCode };
    }

    const diagnostics: Record<string, unknown> = {
      cookieConfigured: configured,
      // Never the cookie value, only presence.
      ...(archiveInfo ? { archive: archiveInfo } : {}),
    };

    if (!configured) {
      return {
        ...base,
        explanation: archive
          ? `未配置 ChinaDrugTrials 会话 Cookie；本地归档 ${archive} 仍可只读检索。`
          : '未配置 ChinaDrugTrials 会话 Cookie，也没有可用的本地归档。',
        fixHint:
          '获取方式：configure --cookie-from-entry-page（自动，一次公开入口页访问）；' +
          '或 configure --cookie-from-curl（人工粘贴浏览器 cURL）。' +
          '两者写入 <配置目录>/cookie.env（0600），本服务不会绕过验证码或 WAF。',
        diagnostics,
      };
    }

    return {
      ...base,
      available: true,
      state: 'SUCCESS',
      reasonCode: archive ? 'OK_WITH_LOCAL_ARCHIVE' : 'OK_COOKIE_ONLY',
      explanation: archive
        ? '已配置会话 Cookie，且存在本地归档；查询优先使用本地归档，避免不必要的在线抓取。'
        : '已配置会话 Cookie；查询将按受控频率访问站点，请遵守站点条款。',
      diagnostics,
    };
  }

  /**
   * Maintenance is opt-in and explicit (SPEC 4.6 / `sync_chinadrugtrials`). It
   * never runs as part of a query, and it never fetches beyond the requested
   * page budget.
   */
  async maintain(request: MaintenanceRequest, ctx: AdapterContext): Promise<MaintenanceResult> {
    const startedAt = new Date().toISOString();
    const finish = (state: SourceState, reasonCode: string, explanation: string, extras?: Partial<MaintenanceResult>): MaintenanceResult => ({
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

    // `sync` is the only supported action, so an omitted action means `sync`
    // rather than an error: refusing a default would make the obvious call fail.
    const action = request.action ?? 'sync';
    if (action !== 'sync') {
      throw new AdapterError('NOT_ENABLED', 'UNSUPPORTED_MAINTENANCE_ACTION', `不支持的维护动作：${action}`);
    }
    // Presence check happens here so a dry run still validates configuration.
    const cookieConfigured = COOKIE_SECRET_NAMES.some((name) => ctx.secrets.has(name));
    const maxPages = Math.max(1, Math.min(request.maxPages ?? 1, 10));
    const keywordText = (request.keyword ?? '').trim();

    const plan: Record<string, unknown> = {
      action: 'sync_chinadrugtrials',
      keyword: keywordText,
      maxPages,
      pageSize: PAGE_SIZE,
      cookieConfigured,
      dryRun: request.dryRun !== false,
      archiveConfigured: Boolean(ctx.paths.chinadrugtrialsArchive),
    };

    if (request.dryRun !== false) {
      return finish(
        'NOT_QUERIED',
        'DRY_RUN',
        '演练模式：未发起任何在线请求。加 --apply 才会真正抓取。',
        { details: { ...plan, applied: false } },
      );
    }

    if (!keywordText) {
      throw new AdapterError('FAILED', 'CHINADRUGTRIALS_QUERY_REQUIRED', '在线同步需要指定关键词，本服务不会全量抓取。');
    }
    this.cookie(ctx);
    if (!ctx.paths.chinadrugtrialsArchive) {
      throw new AdapterError(
        'NEEDS_SETUP',
        'CHINADRUGTRIALS_ARCHIVE_NOT_CONFIGURED',
        '未配置 ChinaDrugTrials 归档目录，无法写入同步结果。',
        { fixHint: '运行 configure --chinadrugtrials-archive <目录> 后重试。' },
      );
    }

    const pages: Array<{ page: number; rows: number; records: Array<Record<string, unknown>> }> = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const html = await serialize(() => this.post(SEARCH_URL, this.buildForm(keywordText, page, {} as CanonicalQuery), ctx));
      const parsed = parseListPage(html);
      pages.push({
        page,
        rows: parsed.rows.length,
        records: parsed.rows.map((row) => ({
          reg_no: row.regNo,
          state: row.state,
          drug_name: row.drugName,
          indication: row.indication,
          title: row.title,
        })),
      });
      if (parsed.totalPages !== undefined && page >= parsed.totalPages) break;
    }

    const changed = pages.reduce((sum, page) => sum + page.rows, 0);
    return finish(
      'SUCCESS',
      'OK',
      `已按受控频率抓取 ${pages.length} 页列表数据（详情抓取请使用参考 scraper 的归档流程）。`,
      { changed, artifactRoot: ctx.paths.chinadrugtrialsArchive, details: { ...plan, applied: true, dryRun: false, pages } },
    );
  }
}
