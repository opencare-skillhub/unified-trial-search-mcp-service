/**
 * Data-cutoff reporting for offline archive sources (SPEC 6.2 / 6.6).
 *
 * An offline package is a snapshot, and the single fact a reader most needs
 * about a snapshot is the moment it stops: every trial registered after that
 * moment is *invisible*, not absent. Without that number a zero-result answer
 * from an archive reads exactly like a zero-result answer from a live registry,
 * which is the one confusion this project exists to prevent.
 *
 * So each archive reports three things it can actually prove:
 *   - `dataCutoff`   : the timestamp no record in the package is newer than;
 *   - `cutoffSource` : how that timestamp was derived, so it can be re-checked;
 *   - `updateHint`   : how a contributor produces a fresher package.
 *
 * The cutoff is always derived from evidence inside the package. It is never
 * hardcoded, because a hardcoded date silently becomes a lie the first time
 * somebody refreshes the data without touching the code.
 */

/** Format a cutoff for display; falls back to the raw value if it is not a date. */
export function formatCutoff(value: string | undefined): string {
  if (!value) return '未知';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  // Render the date in the timestamp's OWN offset, not UTC. These corpora are
  // captured in +08:00, so a UTC slice would report 2026-09-27 for data actually
  // captured on 2026-09-28 - off by a day, in the direction of understating how
  // current the data is. The date is what a reader compares against a
  // registration date, so it has to be the date at the capture site.
  for (const zone of candidateZones(value)) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(ms));
    } catch {
      // Not a zone this runtime knows; try the next candidate.
    }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * IANA zones to try for a timestamp.
 *
 * `UTC+08:00` is NOT a valid IANA zone name - Intl rejects it - so the offset
 * has to be converted to a fixed-offset zone. Both styles are returned because
 * the naive `Etc/GMT-N` sign inversion is easy to get wrong, and the string
 * comparison below picks whichever candidate actually agrees with the input's
 * own local reading.
 */
function candidateZones(value: string): string[] {
  const offset = /([+-])(\d{2}):?(\d{2})?(?=$|\.)/.exec(value.slice(10));
  if (!offset) return ['UTC'];
  // A trailing `Z` is handled by the slice(10) miss above only for offsets, so
  // also normalise an explicit Z.
  const sign = offset[1] === '+' ? 1 : -1;
  const minutes = sign * (Number(offset[2]) * 60 + Number(offset[3] ?? '0'));
  if (minutes === 0) return ['UTC'];
  // Etc/GMT signs are inverted relative to UTC notation (+08:00 => Etc/GMT-8).
  const inverted = minutes > 0 ? `Etc/GMT-${minutes / 60}` : `Etc/GMT+${Math.abs(minutes) / 60}`;
  const candidates = [inverted];
  if (Number.isInteger(minutes / 60)) {
    const hours = minutes / 60;
    candidates.push(hours > 0 ? `Asia/Shanghai` : `America/New_York`);
  }
  return candidates;
}

/** True when the value parses as a date. */
export function isParseableDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Pick the newest of several candidate timestamps.
 *
 * Candidates that do not parse are ignored rather than treated as "now": a
 * malformed timestamp must not be able to make a package look current.
 */
export function latestTimestamp(candidates: Array<string | null | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate || !isParseableDate(candidate)) continue;
    const ms = Date.parse(candidate);
    if (ms > bestMs) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}

/** Oldest parseable timestamp, or undefined when none is usable. */
export function earliestTimestamp(candidates: Array<string | null | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate || !isParseableDate(candidate)) continue;
    const ms = Date.parse(candidate);
    if (ms < bestMs) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}

/**
 * Are the records internally consistent about when they were captured?
 *
 * A package whose records were scraped across a wide window cannot be described
 * by one date without qualification, so callers surface the span instead of
 * pretending the snapshot is uniform.
 */
export interface CutoffAssessment {
  cutoff?: string;
  cutoffSource?: string;
  /** Earliest capture time among records, when it differs meaningfully. */
  captureFrom?: string;
  /** True when records span more than `spreadToleranceMs`. */
  spread: boolean;
  /** Human-readable warning to attach to completeness, if any. */
  warning?: string;
}

export const DEFAULT_SPREAD_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CutoffInput {
  /** Timestamps taken from the individual records of the package. */
  recordTimestamps: Array<string | null | undefined>;
  /** Timestamps declared by package metadata (summary/manifest). */
  packageTimestamps?: Array<string | null | undefined>;
  /** Explanation of how the chosen cutoff was obtained. */
  cutoffSource: string;
  spreadToleranceMs?: number;
  /** Label used in the warning text, e.g. the package name. */
  label?: string;
}

/**
 * Derive the cutoff for one package.
 *
 * The cutoff is the newest evidence available, preferring record-level capture
 * times over declared metadata, because a summary can claim a scrape time that
 * the records themselves do not support. When records are spread beyond the
 * tolerance the earlier end is reported too, so "captured between A and B" can
 * be stated honestly.
 */
export function assessCutoff(input: CutoffInput): CutoffAssessment {
  const tolerance = input.spreadToleranceMs ?? DEFAULT_SPREAD_TOLERANCE_MS;
  const fromRecords = latestTimestamp(input.recordTimestamps);
  const fromPackage = latestTimestamp(input.packageTimestamps ?? []);
  const cutoff = fromRecords ?? fromPackage;

  const earliest = earliestTimestamp(input.recordTimestamps);
  let spread = false;
  if (cutoff && earliest) {
    spread = Date.parse(cutoff) - Date.parse(earliest) > tolerance;
  }

  const assessment: CutoffAssessment = { cutoff, cutoffSource: input.cutoffSource, spread };
  if (earliest && earliest !== cutoff) assessment.captureFrom = earliest;

  if (spread && earliest && cutoff) {
    const name = input.label ? `${input.label}：` : '';
    assessment.warning =
      `${name}包内记录的抓取时间跨度为 ${formatCutoff(earliest)} 至 ${formatCutoff(cutoff)}，` +
      `并非同一次快照；该区间之后登记的试验均不可见，请勿据此判断"不存在"。`;
  }
  return assessment;
}

/** Warning emitted when a package declares a future scrape time. */
export function futureCutoffWarning(declaredAt: string, now: Date, toleranceMs: number): string | undefined {
  const ms = Date.parse(declaredAt);
  if (Number.isNaN(ms)) return undefined;
  if (ms - now.getTime() <= toleranceMs) return undefined;
  return `数据包声明的抓取时间 ${declaredAt} 晚于当前时间，时间戳不可信，已视为数据截止日未知。`;
}
