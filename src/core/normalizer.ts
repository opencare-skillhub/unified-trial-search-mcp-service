/**
 * Normalizer: raw adapter records -> canonical records (SPEC 5.3).
 *
 * Identity is `{sourceId}:{sourceRecordId}` and is immutable. Nothing here
 * invents a source record id; a record lacking one is a contract violation.
 */

import { AdapterError } from './types.js';
import type {
  CanonicalTrialRecord,
  EvidenceRef,
  PiiLevel,
  RawSourceRecord,
  SourceDescriptor,
  SourceId,
} from './types.js';

export function makeRecordId(sourceId: SourceId, sourceRecordId: string): string {
  return `${sourceId}:${sourceRecordId}`;
}

export function parseRecordId(recordId: string): { sourceId: string; sourceRecordId: string } | undefined {
  const index = recordId.indexOf(':');
  if (index <= 0 || index === recordId.length - 1) return undefined;
  return { sourceId: recordId.slice(0, index), sourceRecordId: recordId.slice(index + 1) };
}

/**
 * Normalizes a registry number for comparison. Case and separators vary across
 * sources; the identity of the registration itself does not.
 */
export function normalizeRegistryNumber(value: string): string {
  return value.toUpperCase().replace(/[\s\-_/.]/g, '');
}

export function splitRegistryNumber(
  value: string,
): { registry: string; value: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^([A-Za-z]+)[\s\-_/]?(\d.*)$/.exec(trimmed);
  if (match) return { registry: match[1]!.toUpperCase(), value: match[2]!.replace(/[\s\-_]/g, '') };
  return { registry: 'UNKNOWN', value: trimmed };
}

export function normalizeRecord(
  raw: RawSourceRecord,
  descriptor: SourceDescriptor,
  options: { piiLevel?: PiiLevel; includeRawFields?: boolean; retrievedAt?: string; indexedAt?: string; scrapedAt?: string; contentHash?: string } = {},
): CanonicalTrialRecord {
  const sourceRecordId = raw.sourceRecordId?.trim();
  if (!sourceRecordId) {
    // An adapter that cannot name a stable source identity has failed the
    // contract; this must never silently become an anonymous record.
    throw new AdapterError(
      'FAILED',
      'MISSING_SOURCE_RECORD_ID',
      `来源 ${descriptor.id} 返回了缺少 sourceRecordId 的记录。`,
      { fixHint: '该来源 adapter 需要补齐稳定主键映射。' },
    );
  }

  const provenance: CanonicalTrialRecord['provenance'] = {
    rawEvidenceRefs: raw.evidenceRefs ? [...raw.evidenceRefs] : [],
    piiLevel: options.piiLevel ?? 'public_source_may_contain_pii',
  };
  const retrievedAt = options.retrievedAt;
  if (retrievedAt) provenance.retrievedAt = retrievedAt;
  const indexedAt = options.indexedAt;
  if (indexedAt) provenance.indexedAt = indexedAt;
  const scrapedAt = options.scrapedAt;
  if (scrapedAt) provenance.scrapedAt = scrapedAt;
  const contentHash = options.contentHash ?? raw.contentHash;
  if (contentHash) provenance.contentHash = contentHash;

  const record: CanonicalTrialRecord = {
    recordId: makeRecordId(descriptor.id, sourceRecordId),
    source: { id: descriptor.id, label: descriptor.label, sourceRecordId },
    registryNumbers: dedupeRegistryNumbers(raw.registryNumbers ?? []),
    provenance,
  };

  if (raw.title) record.title = raw.title;
  if (raw.publicTitle) record.publicTitle = raw.publicTitle;
  if (raw.conditionOrDisease?.length) record.conditionOrDisease = [...raw.conditionOrDisease];
  if (raw.interventions?.length) record.interventions = [...raw.interventions];
  if (raw.studyType) record.studyType = raw.studyType;
  if (raw.recruitmentStatus) record.recruitmentStatus = raw.recruitmentStatus;
  if (raw.phase?.length) record.phase = [...raw.phase];
  if (raw.sponsorOrInstitution?.length) record.sponsorOrInstitution = [...raw.sponsorOrInstitution];
  if (raw.countries?.length) record.countries = [...raw.countries];
  if (raw.dates && Object.keys(raw.dates).length) record.dates = { ...raw.dates };
  if (raw.sourceUrl) record.sourceUrl = raw.sourceUrl;
  if (options.includeRawFields && raw.rawFields) record.rawFields = raw.rawFields;

  return record;
}

export function dedupeRegistryNumbers(
  numbers: Array<{ registry: string; value: string; primary?: boolean }>,
): Array<{ registry: string; value: string; primary?: boolean }> {
  const seen = new Map<string, { registry: string; value: string; primary?: boolean }>();
  for (const item of numbers) {
    const value = item.value?.trim();
    if (!value) continue;
    const inferred = item.registry && item.registry !== 'UNKNOWN' ? undefined : splitRegistryNumber(value);
    const registry = (item.registry && item.registry !== 'UNKNOWN' ? item.registry : inferred?.registry ?? 'UNKNOWN').toUpperCase();
    const normalized = inferred ? inferred.value : value.replace(/[\s\-_]/g, '');
    const key = `${registry}:${normalizeRegistryNumber(normalized)}`;
    const existing = seen.get(key);
    if (existing) {
      if (item.primary && !existing.primary) existing.primary = true;
      continue;
    }
    const entry: { registry: string; value: string; primary?: boolean } = { registry, value: normalized };
    if (item.primary) entry.primary = true;
    seen.set(key, entry);
  }
  const out = [...seen.values()];
  // Primary identifiers first, then stable ordering for deterministic output.
  out.sort((a, b) => {
    if (Boolean(b.primary) !== Boolean(a.primary)) return Number(Boolean(b.primary)) - Number(Boolean(a.primary));
    if (a.registry !== b.registry) return a.registry < b.registry ? -1 : 1;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });
  return out;
}

export function evidenceRefKey(ref: EvidenceRef): string {
  return `${ref.kind}|${ref.path}|${ref.contentHash ?? ''}`;
}
