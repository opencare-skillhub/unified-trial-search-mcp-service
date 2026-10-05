/**
 * XYB ChinaDrugTrials read-only archive adapter (SPEC 6.2).
 *
 * The archive is a per-keyword scrape package: `output/<keyword>/summary.json`
 * plus `json/<reg_no>.json`, `raw/*.html`, `word/*.doc`. Coverage is exactly
 * what each package scraped — never "all of ChinaDrugTrials".
 *
 * Timestamp anomalies are treated as first-class warnings, not silently trusted.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AdapterError } from '../core/types.js';
import type {
  AdapterContext,
  AdapterDetailResult,
  AdapterEvidenceResult,
  AdapterSearchResult,
  CanonicalQuery,
  EvidenceRef,
  EvidenceRequest,
  RawSourceRecord,
  RegistryNumber,
  SourceDescriptor,
  SourceStatus,
} from '../core/types.js';
import { getDescriptor } from '../core/registry.js';
import { checkPathReadable } from '../core/config.js';
import { extractTerms } from './chictr-pancreatic.js';

/** summary.json shape, only the fields this service depends on. */
export interface ArchiveSummary {
  keywords?: string;
  scrape_time?: string;
  incremental_mode?: boolean;
  total_records?: number;
  total_pages?: number;
  total_extracted?: number;
  success_count?: number;
  fail_count?: number;
  skip_count?: number;
  word_count?: number;
  json_count?: number;
  results?: Array<{
    reg_no?: string;
    trial_id?: string;
    success?: boolean;
    raw_path?: string;
    json_path?: string;
    content_hash?: string;
    changed?: boolean;
    word_path?: string;
    method?: string;
  }>;
}

interface PackageInfo {
  dir: string;
  name: string;
  summary: ArchiveSummary;
  summaryPath: string;
  warnings: string[];
}

const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Cap per-record warnings so a large archive cannot flood the response. */
const MAX_MISSING_JSON_WARNINGS = 10;

export class XybArchiveAdapter {
  readonly descriptor: SourceDescriptor;

  constructor() {
    this.descriptor = getDescriptor('xyb_chinadrugtrials_archive');
  }

  private async loadPackages(ctx: AdapterContext): Promise<PackageInfo[]> {
    const { packages } = await this.scanPackages(ctx);
    if (!packages.length) {
      throw new AdapterError(
        'NEEDS_SETUP',
        'NO_ARCHIVE_PACKAGES',
        `目录 ${ctx.paths.xybArchive} 下没有可识别的数据包（需要包含 summary.json 的子目录）。`,
        { fixHint: '确认 --xyb-archive 指向数据包的 output 目录。' },
      );
    }
    return packages;
  }

  /**
   * Discover data packages, reporting the ones that were skipped.
   *
   * A package is usable only when it has a `summary.json` manifest. Directories
   * without one are partial/interrupted snapshots: they are skipped by design,
   * but they must be *reported* as skipped. Silently dropping them would let a
   * partial archive masquerade as full coverage.
   */
  private async scanPackages(
    ctx: AdapterContext,
  ): Promise<{ packages: PackageInfo[]; skipped: Array<{ name: string; reason: string }> }> {
    const root = ctx.paths.xybArchive;
    if (!root) {
      throw new AdapterError('NEEDS_SETUP', 'ARCHIVE_NOT_CONFIGURED', '未配置 XYB ChinaDrugTrials 离线数据包目录。', {
        fixHint: '运行 unified-trial-mcp configure --xyb-archive <output 目录的绝对路径>。',
      });
    }
    const check = await checkPathReadable(root, ctx.paths.evidenceRoots, 'dir');
    if (!check.ok) {
      throw new AdapterError('NEEDS_SETUP', check.reasonCode, check.message, { fixHint: check.fixHint });
    }

    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (error) {
      throw new AdapterError('FAILED', 'ARCHIVE_READ_FAILED', `无法读取数据包根目录：${(error as Error).message}`);
    }

    const packages: PackageInfo[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const entry of entries.sort()) {
      const dir = path.join(root, entry);
      let stat;
      try {
        stat = await fs.stat(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || entry.startsWith('.')) continue;

      const summaryPath = path.join(dir, 'summary.json');
      let summary: ArchiveSummary;
      try {
        summary = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as ArchiveSummary;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          skipped.push({
            name: entry,
            reason: '缺少 summary.json 清单，视为未完成的采集快照',
          });
          continue;
        }
        throw new AdapterError(
          'FAILED',
          'SUMMARY_UNRECOGNISED',
          `数据包 ${entry} 的 summary.json 无法解析：${(error as Error).message}`,
          { fixHint: '该数据包结构未知；本服务不会把不可解析的包当作零结果。' },
        );
      }

      const warnings = await inspectSummary(entry, summary);
      const claimed = summary.results?.length ?? 0;
      if (claimed === 0) {
        skipped.push({ name: entry, reason: 'summary.json 未列出任何记录，视为空数据包，已跳过。' });
        continue;
      }
      packages.push({ dir, name: entry, summary, summaryPath, warnings });
    }

    return { packages, skipped };
  }

  private async selectRecords(
    query: CanonicalQuery,
    ctx: AdapterContext,
  ): Promise<{
    records: RawSourceRecord[];
    packages: PackageInfo[];
    totalInScope: number;
    terms: string[];
    warnings: string[];
    incompleteness: string[];
    truncated: boolean;
  }> {
    const { packages, skipped } = await this.scanPackages(ctx);
    const terms = extractTerms(query);
    const warnings: string[] = [];
    const incompleteness: string[] = [];

    // A directory with nothing usable is a setup problem, not an empty result
    // set: reporting SUCCESS/0 here would tell the caller "no such trial
    // exists", which this archive cannot support.
    if (!packages.length) {
      const detail = skipped.length
        ? `目录下 ${skipped.length} 个数据包均不完整：${skipped.map((entry) => `${entry.name}（${entry.reason}）`).join('；')}。`
        : '目录下没有可识别的数据包。';
      throw new AdapterError(
        'NEEDS_SETUP',
        'NO_ARCHIVE_PACKAGES',
        `${detail}请检查 configure --xyb-archive 指向的目录，或补充采集数据。`,
      );
    }

    if (skipped.length) {
      const detail = skipped.map((entry) => `${entry.name}（${entry.reason}）`).join('；');
      warnings.push(`已跳过 ${skipped.length} 个不可用数据包：${detail}。这些包内的记录未纳入本次检索。`);
      incompleteness.push(`packages_skipped:${skipped.length}`);
    }

    const scoped = filterPackagesByTerms(packages, terms);
    if (terms.length && scoped.length < packages.length) {
      warnings.push(
        `仅检索了与关键词匹配的数据包：${scoped.map((p) => p.name).join('、')}（共 ${packages.length} 个数据包）。`,
      );
    }
    if (!scoped.length) {
      warnings.push(`没有任何数据包的关键词与 ${terms.join('、')} 匹配。`);
    }

    for (const pkg of scoped) warnings.push(...pkg.warnings);

    const limit = Math.max(1, Math.min(query.limit ?? 50, this.descriptor.maxResults));
    const offset = Math.max(0, query.offset ?? 0);
    const records: RawSourceRecord[] = [];
    const seen = new Set<string>();
    const missingJson: string[] = [];
    let totalInScope = 0;
    let matched = 0;
    let readFailures = 0;
    let truncated = false;

    outer: for (const pkg of scoped) {
      const results = pkg.summary.results ?? [];
      totalInScope += results.length;

      for (const item of results) {
        const regNo = item.reg_no?.trim();
        if (!regNo || seen.has(regNo)) continue;
        // `summary.results` carries no title, so the json file must be read to
        // decide whether this record matches. Stop early once the page is full
        // rather than reading all 139 files for a 3-row page.
        if (matched >= offset + limit) {
          truncated = true;
          warnings.push(
            `结果已达到请求上限（offset=${offset} limit=${limit}），本服务提前停止扫描该数据包；命中数可能高于返回数。`,
          );
          break outer;
        }
        const jsonPath = (await resolveArchivePath(pkg, item.json_path)) ?? path.join(pkg.dir, 'json', `${regNo}.json`);
        const record = await this.tryReadRecord(jsonPath, pkg, regNo);
        if (!record) {
          readFailures += 1;
          if (missingJson.length < MAX_MISSING_JSON_WARNINGS) missingJson.push(regNo);
          continue;
        }
        if (!matchesRecord(record, query, terms)) continue;
        matched += 1;
        if (matched <= offset) continue;
        seen.add(regNo);
        records.push(record);
      }
    }

    if (missingJson.length) {
      const sample = missingJson.slice(0, 10).join('、');
      warnings.push(
        `数据包中有 ${readFailures} 条记录缺少或无法解析 json 明细（如 ${sample}），这些记录未纳入结果；summary 列出了它们但明细不可读。`,
      );
      if (readFailures > missingJson.length) {
        warnings.push(`另有 ${readFailures - missingJson.length} 条同类记录未逐条列出。`);
      }
      incompleteness.push(`archive_detail_unreadable:${readFailures}`);
    }

    return { records, packages: scoped, totalInScope, terms, warnings, incompleteness, truncated };
  }

  private async tryReadRecord(
    jsonPath: string,
    pkg: PackageInfo,
    regNo: string,
  ): Promise<RawSourceRecord | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as Record<string, unknown>;
      return toRecord(parsed, regNo, pkg);
    } catch {
      // Missing or malformed detail files are counted by the caller and
      // reported as one bounded warning, never one warning per record.
      return undefined;
    }
  }

  async search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const { records, packages, totalInScope, warnings, incompleteness, truncated } = await this.selectRecords(query, ctx);
    const failedCount = packages.reduce((sum, pkg) => sum + (pkg.summary.fail_count ?? 0), 0);
    const expected = readSummaryRecordsTotal(packages);
    // Coverage is judged against the records the packages claim to hold: a
    // short page or an unreadable detail file means the answer is incomplete,
    // never that the source has no matching record.
    const incomplete = truncated || failedCount > 0 || incompleteness.length > 0 || records.length < expected;

    if (failedCount > 0) warnings.push(`该数据包采集时记录了 ${failedCount} 条失败，覆盖可能不完整。`);

    const result: AdapterSearchResult = {
      records,
      upstreamReportedTotal: totalInScope,
      rowsReturned: records.length,
      recordsIncomplete: incomplete,
      truncated,
      warnings,
    };
    if (incompleteness.length) result.incompleteness = incompleteness;
    const scrapedAt = latestScrapeTime(packages);
    if (scrapedAt) result.scrapedAt = scrapedAt;
    return result;
  }

  async getDetail(id: string, ctx: AdapterContext): Promise<AdapterDetailResult> {
    const regNo = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const packages = await this.loadPackages(ctx);
    for (const pkg of packages) {
      const candidate = path.join(pkg.dir, 'json', `${regNo}.json`);
      try {
        const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as Record<string, unknown>;
        return {
          record: toRecord(parsed, regNo, pkg),
          rawFields: {
            details: parsed['details'],
            sections: parsed['sections'],
            list_info: parsed['list_info'],
            rag_chunks: parsed['rag_chunks'],
            package: pkg.name,
          },
          warnings: pkg.warnings,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new AdapterError('FAILED', 'RECORD_UNREADABLE', `${regNo} 的 json 无法解析：${(error as Error).message}`);
      }
    }
    throw new AdapterError('NO_RESULTS', 'RECORD_NOT_FOUND', `未在任何数据包中找到 reg_no=${regNo}。`);
  }

  async getEvidence(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult> {
    const regNo = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const packages = await this.loadPackages(ctx);
    const refs: EvidenceRef[] = [];
    const maxChars = Math.max(0, Math.min(request.maxExcerptChars ?? 4000, 12_000));
    const kinds = request.evidenceKinds;
    const wants = (kind: EvidenceRef['kind']) => !kinds?.length || kinds.includes(kind);

    for (const pkg of packages) {
      const item = (pkg.summary.results ?? []).find((entry) => entry.reg_no?.trim() === regNo);
      const jsonPath =
        (await resolveArchivePath(pkg, item?.json_path)) ?? path.join(pkg.dir, 'json', `${regNo}.json`);
      let exists = false;
      try {
        await fs.access(jsonPath);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists && !item) continue;

      const rel = path.relative(path.resolve(ctx.paths.xybArchive ?? pkg.dir), jsonPath);
      if (wants('source_json') && exists) {
        const ref: EvidenceRef = { kind: 'source_json', path: rel };
        if (item?.content_hash) ref.contentHash = item.content_hash;
        if (pkg.summary.scrape_time) ref.capturedAt = pkg.summary.scrape_time;
        // Carry the record's own structured evidence so a caller can verify a
        // field without opening the file; the path alone forces an out-of-band
        // read of a file the caller may not be able to reach.
        try {
          const parsed = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as Record<string, unknown>;
          const sections = parsed['sections'];
          ref.excerpt = JSON.stringify(
            { reg_no: parsed['reg_no'], sections: sections ?? parsed['details'] ?? null },
            null,
            1,
          ).slice(0, maxChars);
        } catch {
          ref.unavailableReason = '结构化 JSON 证据存在但无法读取或解析。';
        }
        refs.push(ref);
      }
      const archiveRoot = path.resolve(ctx.paths.xybArchive ?? path.dirname(pkg.dir));
      const rawPath = await resolveArchivePath(pkg, item?.raw_path);
      const rawRel = rawPath ? path.relative(archiveRoot, rawPath) : undefined;
      if (wants('raw_html') && item?.raw_path) {
        const ref: EvidenceRef = { kind: 'raw_html', path: rawRel ?? item.raw_path };
        if (item.content_hash) ref.contentHash = item.content_hash;
        const absolute = rawPath ?? path.resolve(pkg.dir, item.raw_path);
        try {
          await fs.access(absolute);
          const html = await fs.readFile(absolute, 'utf8');
          ref.excerpt = html.slice(0, maxChars);
        } catch {
          ref.unavailableReason = '原始 HTML 文件不存在或不可读。';
        }
        refs.push(ref);
      }
      if (wants('source_word') && item?.word_path) {
        // Report every evidence path relative to the archive root so callers
        // can resolve them uniformly; never leak the scrape machine's layout.
        const wordPath = await resolveArchivePath(pkg, item.word_path);
        refs.push({
          kind: 'source_word',
          path: wordPath ? path.relative(archiveRoot, wordPath) : item.word_path,
          unavailableReason: 'Word 为二进制文件，本服务只返回路径而不内联内容。',
        });
      }
      if (refs.length) break;
    }

    if (!refs.length) {
      throw new AdapterError('NO_RESULTS', 'EVIDENCE_NOT_FOUND', `未找到 reg_no=${regNo} 的可用证据引用。`);
    }
    return { refs, warnings: ['证据文件保持只读；本服务不复制也不改写归档。'] };
  }

  async getStatus(ctx: AdapterContext): Promise<SourceStatus> {
    const base: SourceStatus = {
      sourceId: this.descriptor.id,
      label: this.descriptor.label,
      enabled: this.descriptor.enabledByDefault,
      available: false,
      state: 'NEEDS_SETUP',
      reasonCode: 'ARCHIVE_NOT_CONFIGURED',
      explanation: '未配置离线数据包目录。',
      freshness: { kind: this.descriptor.freshness },
      coverage: {
        scope: this.descriptor.scope,
        zeroResultMeaning: this.descriptor.zeroResultMeaning,
        indexOrArchiveOnly: true,
      },
    };
    try {
      const { packages, skipped } = await this.scanPackages(ctx);
      if (!packages.length) {
        const unavailable: SourceStatus = {
          ...base,
          state: 'NEEDS_SETUP',
          reasonCode: 'NO_ARCHIVE_PACKAGES',
          explanation: skipped.length
            ? `目录下 ${skipped.length} 个数据包均不完整（缺少 summary.json 或未列出记录），已全部跳过。`
            : `目录 ${ctx.paths.xybArchive} 下没有可识别的数据包。`,
        };
        unavailable.fixHint = '确认 --xyb-archive 指向包含 summary.json 的数据包 output 目录。';
        return unavailable;
      }
      const scrapedAt = latestScrapeTime(packages);
      const warnings = [...new Set(packages.flatMap((pkg) => pkg.warnings))];
      if (skipped.length) {
        const detail = skipped.map((entry) => `${entry.name}（${entry.reason}）`).join('；');
        warnings.push(`已跳过 ${skipped.length} 个不可用数据包：${detail}。这些包内的记录未纳入本次检索。`);
      }
      const freshness: SourceStatus['freshness'] = { kind: this.descriptor.freshness };
      if (scrapedAt) {
        freshness.scrapedAt = scrapedAt;
        freshness.staleAfterDays = this.descriptor.staleAfterDays;
        const ageDays = (Date.now() - Date.parse(scrapedAt)) / 86_400_000;
        if (!Number.isNaN(ageDays)) freshness.stale = ageDays > (this.descriptor.staleAfterDays ?? 90);
      }
      return {
        ...base,
        available: true,
        state: 'SUCCESS',
        reasonCode: warnings.length ? 'OK_WITH_WARNINGS' : 'OK',
        explanation: `可用数据包 ${packages.length} 个，覆盖关键词：${packages.map((p) => p.summary.keywords ?? p.name).join('、')}。`,
        freshness,
        diagnostics: {
          packages: packages.length,
          skippedPackages: skipped.length,
          totalRecords: packages.reduce((sum, pkg) => sum + (pkg.summary.total_records ?? 0), 0),
          warnings: warnings.join(' | '),
        },
      };
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
    throw new AdapterError('NOT_ENABLED', 'READ_ONLY_ARCHIVE', 'XYB 数据包为只读离线资产，不支持维护操作。', {
      fixHint: '数据包由外部采集流程生成；本服务不会修改它。',
    });
  }
}

/**
 * Resolve a `summary.results[].json_path` / `raw_path` value.
 *
 * Those paths are recorded relative to the scrape *project root* (for example
 * `output/胰腺癌/json/CTR20244170.json`), while this service is configured with
 * the archive `output/` directory. Anchoring them on `pkg.dir` would silently
 * produce `<output>/胰腺癌/output/胰腺癌/json/...`, so try the plausible anchors and
 * return the first one that exists.
 */
async function resolveArchivePath(pkg: PackageInfo, candidate?: string): Promise<string | undefined> {
  if (!candidate) return undefined;
  if (path.isAbsolute(candidate)) return candidate;
  const outputDir = path.dirname(pkg.dir);
  const anchors = [
    outputDir,
    path.dirname(outputDir),
    pkg.dir,
  ];
  const normalized = candidate.split(/[\\/]+/).filter(Boolean).join(path.sep);
  const attempts: string[] = [];
  for (const anchor of anchors) {
    attempts.push(path.join(anchor, normalized));
    // Drop a leading `output/` segment before retrying against the same anchor.
    const stripped = normalized.replace(/^output[\\/]/, '');
    if (stripped !== normalized) attempts.push(path.join(anchor, stripped));
  }
  for (const attempt of attempts) {
    try {
      await fs.access(attempt);
      return attempt;
    } catch {
      // Try the next anchor.
    }
  }
  return attempts[0];
}

function filterPackagesByTerms(packages: PackageInfo[], terms: string[]): PackageInfo[] {
  if (!terms.length) return packages;
  const lowered = terms.map((term) => term.toLowerCase());
  const matched = packages.filter((pkg) => {
    const haystack = `${pkg.summary.keywords ?? ''} ${pkg.name}`.toLowerCase();
    return lowered.some((term) => haystack.includes(term));
  });
  return matched.length ? matched : packages;
}

function matchesRecord(record: RawSourceRecord, query: CanonicalQuery, terms: string[]): boolean {
  if (!terms.length && !query.status?.length) return true;
  const haystack = [
    record.title,
    record.publicTitle,
    ...(record.conditionOrDisease ?? []),
    ...(record.interventions ?? []),
    ...(record.sponsorOrInstitution ?? []),
    // Registration numbers are part of the record's identity, so looking one up
    // by hand must work; they are not "free text" but they are how users cite
    // a specific trial.
    ...(record.registryNumbers ?? []).map((number) => number.value),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (terms.length && !terms.some((term) => haystack.includes(term.toLowerCase()))) return false;
  if (query.status?.length) {
    const status = (record.recruitmentStatus ?? '').toLowerCase();
    if (!query.status.some((wanted) => status.includes(wanted.toLowerCase()))) return false;
  }
  return true;
}

/**
 * Reads only the fields needed to *identify and filter* a record. Field-level
 * structure is validated at detail time so a single malformed record cannot
 * invalidate a whole package.
 */
async function readSummaryRecords(
  pkg: PackageInfo,
): Promise<Array<{ regNo: string; jsonPath: string }>> {
  const results = pkg.summary.results ?? [];
  const mapped = await Promise.all(
    results.map(async (item) => ({
      regNo: item.reg_no?.trim() ?? '',
      jsonPath: (await resolveArchivePath(pkg, item.json_path)) ?? path.join(pkg.dir, 'json', `${item.reg_no?.trim()}.json`),
    })),
  );
  return mapped.filter((entry) => entry.regNo.length > 0);
}

export function toRecord(parsed: Record<string, unknown>, regNo: string, pkg: PackageInfo): RawSourceRecord {
  const details = (parsed['details'] ?? {}) as Record<string, unknown>;
  const sections = (parsed['sections'] ?? {}) as Record<string, Record<string, string>>;
  const listInfo = (parsed['list_info'] ?? {}) as Record<string, unknown>;

  const basic = sections['基本信息'] ?? {};
  const background = sections['一、题目和背景信息'] ?? {};

  // Nested sections are authoritative over flattened detail keys (SPEC 6.2).
  const title =
    firstNonEmpty(background['试验专业题目'], details['试验专业题目'], listInfo['title']) ??
    firstNonEmpty(basic['登记号']) ??
    regNo;
  const publicTitle = firstNonEmpty(background['试验通俗题目'], details['试验通俗题目'], listInfo['title']);
  const indication = firstNonEmpty(background['适应症'], details['适应症'], listInfo['indication']);
  const drugName = firstNonEmpty(background['药物名称'], details['药物名称'], listInfo['drug_name']);

  const registryNumbers: RegistryNumber[] = [{ registry: 'CTR', value: regNo, primary: true }];
  const related = firstNonEmpty(background['相关登记号'], details['相关登记号']);
  if (related) {
    for (const value of related.split(/[;；,，、\s]+/)) {
      const trimmed = value.trim();
      if (trimmed && /^CTR\d+/i.test(trimmed)) registryNumbers.push({ registry: 'CTR', value: trimmed });
    }
  }

  const source = (parsed['source'] ?? {}) as Record<string, unknown>;
  const record: RawSourceRecord = {
    sourceRecordId: regNo,
    registryNumbers,
    rawFields: {},
  };
  if (title) record.title = clean(title);
  if (publicTitle) record.publicTitle = clean(publicTitle);
  if (indication) record.conditionOrDisease = splitMultiValue(clean(indication));
  if (drugName) record.interventions = splitMultiValue(clean(drugName));
  const status = firstNonEmpty(basic['试验状态'], details['试验状态'], listInfo['state']);
  if (status) record.recruitmentStatus = clean(status);
  const sponsor = firstNonEmpty(sections['二、申请人信息']?.['申请人名称'], details['申请人名称']);
  if (sponsor && sponsor !== '12') record.sponsorOrInstitution = [clean(sponsor)];
  const type = firstNonEmpty(background['药物类型'], details['药物类型']);
  if (type) record.studyType = clean(type);

  const detailUrl = firstNonEmpty(
    typeof source['detail_url'] === 'string' ? source['detail_url'] : undefined,
    sections['基本信息']?.['详情链接'],
  );
  if (detailUrl) record.sourceUrl = detailUrl;

  const dates: NonNullable<RawSourceRecord['dates']> = {};
  const firstPublic = firstNonEmpty(basic['首次公示信息日期'], details['首次公示信息日期']);
  if (firstPublic) dates.registered = firstPublic;
  const scrapeTime = typeof parsed['scrape_time'] === 'string' ? parsed['scrape_time'] : pkg.summary.scrape_time;
  if (scrapeTime) dates.updated = scrapeTime;
  if (Object.keys(dates).length) record.dates = dates;

  const hash = typeof parsed['content_hash'] === 'string' ? parsed['content_hash'] : undefined;
  if (hash) record.contentHash = hash;

  const rawHtmlPath = typeof source['raw_html_path'] === 'string' ? source['raw_html_path'] : undefined;
  const evidenceRefs: EvidenceRef[] = [];
  if (rawHtmlPath) {
    evidenceRefs.push({ kind: 'raw_html', path: rawHtmlPath, ...(hash ? { contentHash: hash } : {}) });
  }
  record.evidenceRefs = evidenceRefs;

  return record;
}

function firstNonEmpty(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() && value.trim() !== '企业选择不公示') return value;
  }
  return undefined;
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/曾用名:\s*$/, '').trim();
}

function splitMultiValue(value: string): string[] {
  const parts = value
    .split(/[\n;；]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length ? parts : [value];
}

function latestScrapeTime(packages: PackageInfo[]): string | undefined {
  const times = packages
    .map((pkg) => pkg.summary.scrape_time)
    .filter((time): time is string => typeof time === 'string' && time.length > 0)
    .sort();
  return times.length ? times[times.length - 1] : undefined;
}

/** Total record slots the packages claim, used to judge coverage. */
function readSummaryRecordsTotal(packages: PackageInfo[]): number {
  return packages.reduce((sum, pkg) => sum + (pkg.summary.results?.length ?? 0), 0);
}

/** Detects the summary/record timestamp anomalies the SPEC calls out. */
export async function inspectSummary(name: string, summary: ArchiveSummary): Promise<string[]> {
  const warnings: string[] = [];
  const now = Date.now();

  if (!summary.scrape_time) {
    warnings.push(`数据包 ${name} 的 summary.json 缺少 scrape_time；无法判断归档新鲜度。`);
  } else {
    const parsed = Date.parse(summary.scrape_time);
    if (Number.isNaN(parsed)) {
      warnings.push(`数据包 ${name} 的 scrape_time 无法解析：${summary.scrape_time}。`);
    } else if (parsed - now > FUTURE_TOLERANCE_MS) {
      warnings.push(
        `数据包 ${name} 的 scrape_time=${summary.scrape_time} 位于未来，归档时间不可信。`,
      );
    }
  }

  const listed = summary.results?.length ?? 0;
  if (typeof summary.total_records === 'number' && summary.total_records !== listed) {
    warnings.push(
      `数据包 ${name} 的 summary 记录数不一致：total_records=${summary.total_records}，results=${listed}。`,
    );
  }
  if (typeof summary.total_extracted === 'number' && summary.total_extracted !== listed) {
    warnings.push(
      `数据包 ${name} 的 total_extracted=${summary.total_extracted} 与 results 数量 ${listed} 不一致。`,
    );
  }
  if ((summary.fail_count ?? 0) > 0) {
    warnings.push(`数据包 ${name} 记录了 ${summary.fail_count} 条抓取失败，覆盖不完整。`);
  }
  return warnings;
}

export { readSummaryRecords };
