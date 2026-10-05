/**
 * Canonical types for the unified trial MCP service.
 * These mirror SPEC.md sections 3, 5 and 6 and are the single source of truth
 * shared by the registry, orchestrator, normalizer, merger and adapters.
 */

export type SourceId =
  | 'ictrp'
  | 'ctv'
  | 'chictr_online'
  | 'chictr_pancreatic_archive'
  | 'chinadrugtrials'
  | 'xyb_chinadrugtrials_archive';

/**
 * Terminal state of one source for one call. Only SUCCESS and NO_RESULTS mean
 * the source was actually queried (SPEC 5.1). Nothing else may be folded into
 * "zero results".
 */
export type SourceState =
  | 'SUCCESS'
  | 'NO_RESULTS'
  | 'NOT_ENABLED'
  | 'NEEDS_SETUP'
  | 'NOT_QUERIED'
  | 'TIMEOUT'
  | 'CHALLENGE_REQUIRED'
  | 'RATE_LIMITED'
  | 'DENIED'
  | 'FAILED';

/** States that prove the upstream was actually consulted. */
export const QUERIED_STATES: readonly SourceState[] = ['SUCCESS', 'NO_RESULTS'];

export function wasQueried(state: SourceState): boolean {
  return QUERIED_STATES.includes(state);
}

export type SourceKind = 'mcp' | 'sqlite' | 'archive' | 'controlled_scraper';

export type FreshnessKind =
  | 'cached_network'
  | 'local_index'
  | 'offline_archive'
  | 'controlled_session_archive';

export type PiiLevel = 'public_source_may_contain_pii' | 'none_known';

export interface CanonicalQuery {
  keyword?: string;
  keywords?: string[];
  condition?: string;
  terms?: string;
  status?: string[];
  phase?: string[];
  country?: string;
  isChina?: boolean;
  startDateFrom?: string;
  startDateTo?: string;
  sourceIds?: SourceId[];
  limit?: number;
  offset?: number;
}

export interface RegistryNumber {
  registry: string;
  value: string;
  primary?: boolean;
}

export interface EvidenceRef {
  kind: 'raw_html' | 'source_json' | 'source_word' | 'raw_text' | 'field_excerpt';
  /** Path relative to an allowlisted root, never an arbitrary caller path. */
  path: string;
  sourceUrl?: string;
  contentHash?: string;
  capturedAt?: string;
  excerpt?: string;
  unavailableReason?: string;
}

export interface CanonicalTrialRecord {
  recordId: string;
  source: { id: SourceId; label: string; sourceRecordId: string };
  registryNumbers: RegistryNumber[];
  title?: string;
  publicTitle?: string;
  conditionOrDisease?: string[];
  interventions?: string[];
  studyType?: string;
  recruitmentStatus?: string;
  phase?: string[];
  sponsorOrInstitution?: string[];
  countries?: string[];
  dates?: { registered?: string; started?: string; updated?: string; completed?: string };
  sourceUrl?: string;
  provenance: {
    retrievedAt?: string;
    indexedAt?: string;
    scrapedAt?: string;
    contentHash?: string;
    rawEvidenceRefs: EvidenceRef[];
    piiLevel: PiiLevel;
  };
  mergedFrom?: string[];
  sourceLabels?: string[];
  perSource?: Array<{ recordId: string; sourceId: SourceId; sourceRecordId: string }>;
  /** Raw source fields, only populated when explicitly requested. */
  rawFields?: Record<string, unknown>;
}

export interface SourceConclusion {
  sourceId: SourceId;
  sourceLabel: string;
  state: SourceState;
  reasonCode: string;
  explanation: string;
  attempted: boolean;
  elapsedMs: number;
  resultCount?: number;
  requestedLimit?: number;
  truncated?: boolean;
  freshness: {
    kind: FreshnessKind;
    retrievedAt?: string;
    indexedAt?: string;
    scrapedAt?: string;
    staleAfterDays?: number;
    stale?: boolean;
  };
  coverage: {
    scope: string;
    zeroResultMeaning: string;
    indexOrArchiveOnly: boolean;
  };
  completeness: {
    isLowerBound: boolean;
    upstreamReportedTotal?: number;
    rowsReturned?: number;
    recordsIncomplete?: boolean;
    warnings: string[];
  };
  fixHint?: string;
}

export interface UnifiedSearchResponse {
  schemaVersion: '1.0';
  query: CanonicalQuery;
  statuses: SourceConclusion[];
  coverage: { queried: SourceId[]; unavailable: SourceId[]; notQueried: SourceId[] };
  completeness: { isComplete: boolean; warnings: string[] };
  totalRecords: number;
  records: CanonicalTrialRecord[];
  overlaps: Array<{ registryNumber: string; recordIds: string[]; mergeApplied: boolean }>;
  startedAt: string;
  elapsedMs: number;
  cancelled: boolean;
  disclaimer: string;
}

export interface SourceDescriptor {
  id: SourceId;
  label: string;
  kind: SourceKind;
  enabledByDefault: boolean;
  queryTimeoutMs: number;
  maxResults: number;
  argShape: (query: CanonicalQuery) => unknown;
  freshness: FreshnessKind;
  supportsDetail: boolean;
  supportsEvidence: boolean;
  supportsMaintenance: boolean;
  identityRule: string;
  zeroResultMeaning: string;
  /** Allowlisted roots for evidence reads, from config, never from callers. */
  allowedRoots?: string[];
  /** Operational scope note surfaced in coverage.scope. */
  scope: string;
  /** Lower bound by nature (e.g. ICTRP incompleteness). */
  isLowerBound?: boolean;
  staleAfterDays?: number;
}

/** Result of one adapter search. */
export interface AdapterSearchResult {
  records: RawSourceRecord[];
  /** Count as reported by the upstream, when it differs from records.length. */
  upstreamReportedTotal?: number;
  rowsReturned?: number;
  recordsIncomplete?: boolean;
  truncated?: boolean;
  retrievedAt?: string;
  indexedAt?: string;
  scrapedAt?: string;
  warnings?: string[];
  /**
   * Machine-readable reasons this result is not a complete answer (skipped
   * packages, partial pages, failed detail fetches, ...). Distinct from
   * `warnings`, which is prose. Dropping these would let an incomplete result
   * look complete.
   */
  incompleteness?: string[];
  /**
   * Source-declared coverage of the searched corpus (CTV indexes, archive
   * package counts, ...). Never omitted for index/archive sources, because a
   * zero result must be readable as "not in this subset".
   */
  coverage?: Record<string, unknown>;
}

/**
 * A record as returned by an adapter before canonical normalization. Adapters
 * must never invent fields; `sourceRecordId` is non-negotiable.
 */
export interface RawSourceRecord {
  sourceRecordId: string;
  registryNumbers?: RegistryNumber[];
  title?: string;
  publicTitle?: string;
  conditionOrDisease?: string[];
  interventions?: string[];
  studyType?: string;
  recruitmentStatus?: string;
  phase?: string[];
  sponsorOrInstitution?: string[];
  countries?: string[];
  dates?: { registered?: string; started?: string; updated?: string; completed?: string };
  sourceUrl?: string;
  acronym?: string;
  contentHash?: string;
  evidenceRefs?: EvidenceRef[];
  rawFields?: Record<string, unknown>;
}

export interface AdapterContext {
  signal: AbortSignal;
  timeoutMs: number;
  /** Absolute paths resolved from config; adapters must not accept caller paths. */
  paths: ResolvedPaths;
  logger: Logger;
  /** Secrets are exposed only through this accessor and never logged. */
  secrets: SecretAccessor;
}

export interface AdapterDetailResult {
  record: RawSourceRecord;
  rawFields?: Record<string, unknown>;
  warnings?: string[];
}

export interface EvidenceRequest {
  evidenceKinds?: EvidenceRef['kind'][];
  maxExcerptChars?: number;
}

export interface AdapterEvidenceResult {
  refs: EvidenceRef[];
  warnings?: string[];
}

export interface SourceStatus {
  sourceId: SourceId;
  label: string;
  enabled: boolean;
  available: boolean;
  state: SourceState;
  reasonCode: string;
  explanation: string;
  fixHint?: string;
  freshness: SourceConclusion['freshness'];
  coverage: SourceConclusion['coverage'];
  diagnostics?: Record<string, unknown>;
}

export interface MaintenanceRequest {
  /** Maintenance verb, e.g. `sync`; adapters reject anything unsupported. */
  action?: string;
  /** Single keyword for sources that need one (ChinaDrugTrials sync). */
  keyword?: string;
  force?: boolean;
  mode?: 'csv_import' | 'sitemap_sync' | 'detail_backfill';
  maxShards?: number;
  maxRecords?: number;
  keywords?: string[];
  maxPages?: number;
  delaySeconds?: number;
  incremental?: boolean;
  /**
   * Plan-only run. Defaults to true for bootstrap; the tools and CLI pass an
   * explicit flag so nothing is ever applied by accident.
   */
  dryRun?: boolean;
  filters?: Record<string, string | string[]>;
}

export interface MaintenanceResult {
  sourceId: SourceId;
  state: SourceState;
  reasonCode: string;
  explanation: string;
  changed: number;
  skipped: number;
  failed: number;
  artifactRoot?: string;
  startedAt: string;
  finishedAt: string;
  warnings: string[];
  /** Source-specific plan/pages detail, for doctor and CLI output. */
  details?: Record<string, unknown>;
}

export interface TrialSourceAdapter {
  readonly descriptor: SourceDescriptor;
  search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult>;
  getDetail?(id: string, ctx: AdapterContext): Promise<AdapterDetailResult>;
  getEvidence?(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult>;
  getStatus(ctx: AdapterContext): Promise<SourceStatus>;
  maintain?(request: MaintenanceRequest, ctx: AdapterContext): Promise<MaintenanceResult>;
}

/**
 * Adapter failures carry a source state so the orchestrator never has to guess
 * whether an error means "no results" or "not consulted".
 */
export class AdapterError extends Error {
  readonly state: SourceState;
  readonly reasonCode: string;
  readonly fixHint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    state: SourceState,
    reasonCode: string,
    message: string,
    options?: { fixHint?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AdapterError';
    this.state = state;
    this.reasonCode = reasonCode;
    this.fixHint = options?.fixHint;
    this.details = options?.details;
  }
}

export interface ResolvedPaths {
  configDir: string;
  workDir: string;
  ictrpBundle?: string;
  ctvDatabase?: string;
  /** Directory of the ctv-mcp-server checkout that owns ctvDatabase. */
  ctvMcpServer?: string;
  /** Host-configured CTV CSV export; never supplied by a tool caller. */
  ctvCsvExport?: string;
  chictrCorpus?: string;
  /** Directory of the chictr_trials checkout that provides the online MCP. */
  chictrMcpServer?: string;
  xybArchive?: string;
  chinadrugtrialsArchive?: string;
  evidenceRoots: string[];
}

export interface SecretAccessor {
  /** Returns undefined when unset; callers must never log the value. */
  get(name: string): string | undefined;
  has(name: string): boolean;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
