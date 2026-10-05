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

/** Offset of a timestamp string as minutes east of UTC, or undefined if absent. */
export function offsetMinutesOf(value: string): number | undefined {
  const match = /(?:Z|([+-])(\d{2}):?(\d{2})?)$/.exec(value.trim());
  if (!match) return undefined;
  if (!match[1]) return 0; // trailing Z
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? '0'));
}

/**
 * Format a cutoff for display; falls back to the raw value if it is not a date.
 *
 * The date is rendered in the timestamp's OWN offset, not UTC. These corpora are
 * captured at +08:00, so slicing UTC reported 2026-09-27 for data captured on
 * 2026-09-28 - off by a day, in the direction of understating how current the
 * data is. A reader compares this against a registration date, so it has to be
 * the date at the capture site.
 *
 * The shift is plain arithmetic rather than `Intl` time-zone lookup: offset zone
 * names are not portable (`Etc/GMT-8` resolved on macOS but not in CI's ICU
 * build, and `UTC+08:00` is rejected everywhere), and an offset is exactly the
 * kind of value that should not depend on a timezone database at all.
 */
export function formatCutoff(value: string | undefined): string {
  if (!value) return '未知';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const offset = offsetMinutesOf(value);
  const shifted = offset === undefined ? new Date(ms) : new Date(ms + offset * 60_000);
  // With an explicit offset, shift to that offset and read UTC fields, so the
  // result is independent of the machine's timezone.
  // Without one, ECMAScript parses a `T` form as LOCAL time, so the local fields
  // are the ones the producer wrote; reading UTC fields there would re-impose a
  // timezone the timestamp never claimed, and the date would depend on the host.
  const useUtcFields = offset !== undefined;
  const year = useUtcFields ? shifted.getUTCFullYear() : shifted.getFullYear();
  const month = (useUtcFields ? shifted.getUTCMonth() : shifted.getMonth()) + 1;
  const day = useUtcFields ? shifted.getUTCDate() : shifted.getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
