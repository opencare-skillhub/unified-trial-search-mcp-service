/**
 * Closed, statically registered source registry (SPEC 3.2, ADR-002).
 *
 * Callers may only narrow this set. They can never add a source, choose a tool
 * name, pass a URL, command, timeout or raw adapter argument.
 */

import type { CanonicalQuery, SourceDescriptor, SourceId } from './types.js';

const MAX_RESULTS_DEFAULT = 200;

function baseArgShape(query: CanonicalQuery): unknown {
  return {
    keyword: query.keyword,
    keywords: query.keywords,
    condition: query.condition,
    terms: query.terms,
    status: query.status,
    phase: query.phase,
    country: query.country,
    isChina: query.isChina,
    startDateFrom: query.startDateFrom,
    startDateTo: query.startDateTo,
    limit: query.limit,
    offset: query.offset,
  };
}

export const SOURCE_IDS: readonly SourceId[] = [
  'chinadrugtrials',
  'xyb_chinadrugtrials_archive',
  'chictr_online',
  'chictr_pancreatic_archive',
  'ctv',
  'ictrp',
] as const;

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === 'string' && (SOURCE_IDS as readonly string[]).includes(value);
}

/**
 * Registry order is the *presentation* order and the tie-break order for
 * deterministic scheduling and sorting.
 */
export const SOURCE_REGISTRY: readonly SourceDescriptor[] = [
  {
    id: 'chinadrugtrials',
    label: 'ChinaDrugTrials（受控归档）',
    kind: 'controlled_scraper',
    enabledByDefault: true,
    queryTimeoutMs: 30_000,
    maxResults: MAX_RESULTS_DEFAULT,
    argShape: baseArgShape,
    freshness: 'controlled_session_archive',
    supportsDetail: true,
    supportsEvidence: true,
    supportsMaintenance: true,
    identityRule: 'reg_no 为来源主键；详情审计优先 sections/原始 HTML/Word/hash。',
    zeroResultMeaning: '仅表示本地受控归档中无该关键词命中，不代表官网无该试验。',
    scope: '本地受控增量归档；仅同步时联网，且需要合法的用户会话。',
    staleAfterDays: 30,
  },
  {
    id: 'xyb_chinadrugtrials_archive',
    label: 'XYB ChinaDrugTrials 数据包（只读离线）',
    kind: 'archive',
    enabledByDefault: true,
    queryTimeoutMs: 15_000,
    maxResults: MAX_RESULTS_DEFAULT,
    argShape: baseArgShape,
    freshness: 'offline_archive',
    supportsDetail: true,
    supportsEvidence: true,
    supportsMaintenance: false,
    identityRule: 'reg_no 为来源主键；以数据包内 json/summary.json 为准。',
    zeroResultMeaning:
      '仅表示该离线数据包内无命中；本包是按关键词抓取的子集，不是全量 ChinaDrugTrials，' +
      '也不包含数据截止日之后登记的试验。',
    scope:
      '只读离线数据包，覆盖范围取决于包内查询关键词与页数；数据截止日由包内记录时间戳推导，' +
      '该日期之后登记的试验在包内不可见。',
    staleAfterDays: 90,
  },
  {
    id: 'chictr_online',
    label: 'ChiCTR 在线',
    kind: 'mcp',
    enabledByDefault: true,
    queryTimeoutMs: 45_000,
    maxResults: MAX_RESULTS_DEFAULT,
    argShape: baseArgShape,
    freshness: 'cached_network',
    supportsDetail: true,
    supportsEvidence: true,
    supportsMaintenance: true,
    identityRule: 'project_id 为来源主键；registration_number 可空，禁止单独作为身份。',
    zeroResultMeaning: '仅表示本次在线查询无命中；结果依赖短期会话与缓存。',
    scope: '在线查询，受 WAF、会话有效期与限流约束。',
    staleAfterDays: 7,
  },
  {
    id: 'chictr_pancreatic_archive',
    label: 'ChiCTR 胰腺癌离线语料',
    kind: 'sqlite',
    enabledByDefault: true,
    queryTimeoutMs: 15_000,
    maxResults: MAX_RESULTS_DEFAULT,
    argShape: baseArgShape,
    freshness: 'offline_archive',
    supportsDetail: true,
    supportsEvidence: true,
    supportsMaintenance: false,
    identityRule: 'SQLite trials.project_id 为来源主键；registration_number 可为 NULL。',
    zeroResultMeaning:
      '仅表示该胰腺癌专题语料内无命中；不覆盖 ChiCTR 全量与其他疾病领域，' +
      '也不包含数据截止日之后登记的试验。',
    scope:
      '仅胰腺癌专题离线语料，非 ChiCTR 全量；数据截止日由语料内时间戳推导，' +
      '该日期之后登记的试验在语料中不可见。',
    staleAfterDays: 90,
  },
  {
    id: 'ctv',
    label: 'ClinicalTrials.gov（CTV 本地索引）',
    kind: 'mcp',
    enabledByDefault: true,
    queryTimeoutMs: 20_000,
    maxResults: MAX_RESULTS_DEFAULT,
    argShape: baseArgShape,
    freshness: 'local_index',
    supportsDetail: true,
    supportsEvidence: true,
    supportsMaintenance: true,
    identityRule: '稳定 study ID/slug 为来源主键；保留 NCT/UTN 作为可靠登记号。',
    zeroResultMeaning: '仅表示本地 SQLite/FTS 索引未命中，不代表 ClinicalTrials.gov 上不存在该试验。',
    scope: '本地全文索引；未同步的记录不可见。',
    staleAfterDays: 30,
  },
  {
    id: 'ictrp',
    label: 'WHO ICTRP',
    kind: 'mcp',
    enabledByDefault: true,
    queryTimeoutMs: 60_000,
    maxResults: MAX_RESULTS_DEFAULT,
    argShape: baseArgShape,
    freshness: 'cached_network',
    supportsDetail: true,
    supportsEvidence: true,
    supportsMaintenance: true,
    identityRule: 'registry + primary ID 为来源主键；不得仅用标题或注册号模糊匹配。',
    zeroResultMeaning: '仅表示本次 ICTRP 查询无返回；上游存在已知静默缺失，零结果不能作为“不存在”的结论。',
    scope: '全球登记库聚合；已知上游结果不完整。',
    isLowerBound: true,
    staleAfterDays: 7,
  },
] as const;

const REGISTRY_BY_ID = new Map<SourceId, SourceDescriptor>(SOURCE_REGISTRY.map((d) => [d.id, d]));

export function getDescriptor(id: SourceId): SourceDescriptor {
  const descriptor = REGISTRY_BY_ID.get(id);
  if (!descriptor) throw new Error(`未知来源：${id}`);
  return descriptor;
}

/** Registry presentation/scheduling order index. */
export function registryOrder(id: SourceId): number {
  return SOURCE_IDS.indexOf(id);
}

/**
 * Resolves the effective source set for one call. Unknown ids are rejected;
 * callers can only narrow, never extend.
 */
export function resolveRequestedSources(
  requested: readonly string[] | undefined,
  enabled: ReadonlySet<SourceId> = defaultEnabledSources(),
): { sources: SourceDescriptor[]; rejected: string[] } {
  const rejected: string[] = [];
  const selected: SourceDescriptor[] = [];

  const candidates = requested && requested.length
    ? requested
    : SOURCE_REGISTRY.filter((d) => enabled.has(d.id)).map((d) => d.id);

  for (const raw of candidates) {
    if (!isSourceId(raw)) {
      rejected.push(String(raw));
      continue;
    }
    const descriptor = getDescriptor(raw);
    if (!enabled.has(descriptor.id)) continue;
    if (!selected.some((d) => d.id === descriptor.id)) selected.push(descriptor);
  }

  // Present in registry order regardless of request order (SPEC 3.3).
  selected.sort((a, b) => registryOrder(a.id) - registryOrder(b.id));
  return { sources: selected, rejected };
}

export function defaultEnabledSources(): Set<SourceId> {
  return new Set(SOURCE_REGISTRY.filter((d) => d.enabledByDefault).map((d) => d.id));
}

/** Estimated duration used for longest-processing-time-first scheduling. */
export function estimatedDurationMs(id: SourceId): number {
  return getDescriptor(id).queryTimeoutMs;
}

/** Schedules sources longest-first so slow ones are never starved (SPEC 3.3). */
export function scheduleLongestFirst(descriptors: readonly SourceDescriptor[]): SourceDescriptor[] {
  return [...descriptors].sort((a, b) => {
    const diff = estimatedDurationMs(b.id) - estimatedDurationMs(a.id);
    return diff !== 0 ? diff : registryOrder(a.id) - registryOrder(b.id);
  });
}
