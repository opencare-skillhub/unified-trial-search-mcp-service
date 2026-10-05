/**
 * Conservative merger (SPEC 5.3, ADR-004).
 *
 * Merges ONLY when a reliable, normalized registration number is identical
 * across sources, or when an explicitly maintained cross-source mapping exists.
 * Titles, sponsors, conditions, interventions and dates may never cause a merge
 * — they only justify a hint.
 *
 * A merged group keeps every member's original fields. Nothing is overwritten.
 */

import { normalizeRegistryNumber } from './normalizer.js';
import type { CanonicalTrialRecord, RegistryNumber, SourceId } from './types.js';

export interface MergeOptions {
  /** Explicit maintained mappings: normalized registry number -> record ids. */
  explicitMappings?: Map<string, string[]>;
  /**
   * Registries considered reliable enough to merge on. All registries observed
   * in the input are reliable by default; this exists for future narrowing.
   */
  reliableRegistries?: Set<string>;
}

export interface OverlapEntry {
  registryNumber: string;
  recordIds: string[];
  mergeApplied: boolean;
}

export interface MergeResult {
  records: CanonicalTrialRecord[];
  overlaps: OverlapEntry[];
}

function keyOf(number: RegistryNumber): string {
  return `${number.registry.toUpperCase()}:${normalizeRegistryNumber(number.value)}`;
}

function displayOf(number: RegistryNumber): string {
  return `${number.registry}:${number.value}`;
}

/**
 * Union-find over record ids, joined only by shared reliable identifiers or
 * explicit mappings.
 */
class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    const parent = this.parent.get(id);
    if (parent === undefined) {
      this.parent.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

export function mergeRecords(
  records: readonly CanonicalTrialRecord[],
  options: MergeOptions = {},
): MergeResult {
  const reliable = options.reliableRegistries;
  const byKey = new Map<string, string[]>();
  const recordById = new Map<string, CanonicalTrialRecord>();

  for (const record of records) {
    recordById.set(record.recordId, record);
    for (const number of record.registryNumbers) {
      if (reliable && !reliable.has(number.registry.toUpperCase())) continue;
      const key = keyOf(number);
      const list = byKey.get(key);
      if (list) {
        if (!list.includes(record.recordId)) list.push(record.recordId);
      } else {
        byKey.set(key, [record.recordId]);
      }
    }
  }

  const explicit = options.explicitMappings;
  if (explicit) {
    for (const [key, ids] of explicit) {
      const present = ids.filter((id) => recordById.has(id));
      if (present.length < 2) continue;
      const normalizedKey = key.includes(':') ? key.toUpperCase() : key;
      const existing = byKey.get(normalizedKey) ?? [];
      byKey.set(normalizedKey, [...new Set([...existing, ...present])]);
    }
  }

  const dsu = new DisjointSet();
  const overlaps: OverlapEntry[] = [];

  for (const [key, ids] of byKey) {
    if (ids.length < 2) continue;
    const mergeApplied = ids.length >= 2;
    for (let i = 1; i < ids.length; i += 1) dsu.union(ids[0]!, ids[i]!);
    const [registry, ...rest] = key.split(':');
    overlaps.push({
      registryNumber: `${registry}:${rest.join(':')}`,
      recordIds: [...ids].sort(),
      mergeApplied,
    });
  }

  const groups = new Map<string, CanonicalTrialRecord[]>();
  for (const [id, record] of recordById) {
    const root = dsu.find(id);
    const list = groups.get(root);
    if (list) list.push(record);
    else groups.set(root, [record]);
  }

  const merged: CanonicalTrialRecord[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      merged.push(stripMergeFields(members[0]!));
      continue;
    }
    merged.push(combineGroup(members));
  }

  merged.sort(compareCanonical);
  overlaps.sort((a, b) => (a.registryNumber < b.registryNumber ? -1 : a.registryNumber > b.registryNumber ? 1 : 0));
  return { records: merged, overlaps };
}

function stripMergeFields(record: CanonicalTrialRecord): CanonicalTrialRecord {
  const copy: CanonicalTrialRecord = { ...record };
  delete copy.mergedFrom;
  delete copy.sourceLabels;
  delete copy.perSource;
  return copy;
}

/**
 * Builds a deterministic merged view. The head record is the highest-priority
 * source member; its scalar values are preferred only where they exist, and no
 * conflicting member value is discarded — every member remains addressable via
 * `perSource` and `mergedFrom`.
 */
function combineGroup(members: CanonicalTrialRecord[]): CanonicalTrialRecord {
  const sorted = [...members].sort((a, b) => compareCanonicalForHead(a, b));
  const head = sorted[0]!;

  const registryNumbers = new Map<string, RegistryNumber>();
  for (const member of sorted) {
    for (const number of member.registryNumbers) {
      const key = keyOf(number);
      const existing = registryNumbers.get(key);
      if (!existing) registryNumbers.set(key, { ...number });
      else if (number.primary) existing.primary = true;
    }
  }

  const conditions = new Set<string>();
  const interventions = new Set<string>();
  const phases = new Set<string>();
  const sponsors = new Set<string>();
  const countries = new Set<string>();
  const evidence = [...head.provenance.rawEvidenceRefs];
  const evidenceKeys = new Set(evidence.map((ref) => `${ref.kind}|${ref.path}`));

  for (const member of sorted) {
    for (const value of member.conditionOrDisease ?? []) conditions.add(value);
    for (const value of member.interventions ?? []) interventions.add(value);
    for (const value of member.phase ?? []) phases.add(value);
    for (const value of member.sponsorOrInstitution ?? []) sponsors.add(value);
    for (const value of member.countries ?? []) countries.add(value);
    for (const ref of member.provenance.rawEvidenceRefs) {
      const key = `${ref.kind}|${ref.path}`;
      if (!evidenceKeys.has(key)) {
        evidenceKeys.add(key);
        evidence.push(ref);
      }
    }
  }

  const merged: CanonicalTrialRecord = {
    ...head,
    registryNumbers: [...registryNumbers.values()].sort((a, b) => {
      if (Boolean(b.primary) !== Boolean(a.primary)) return Number(Boolean(b.primary)) - Number(Boolean(a.primary));
      const keyA = keyOf(a);
      const keyB = keyOf(b);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    }),
    conditionOrDisease: conditions.size ? [...conditions] : undefined,
    interventions: interventions.size ? [...interventions] : undefined,
    phase: phases.size ? [...phases] : undefined,
    sponsorOrInstitution: sponsors.size ? [...sponsors] : undefined,
    countries: countries.size ? [...countries] : undefined,
    provenance: {
      ...head.provenance,
      rawEvidenceRefs: evidence,
      piiLevel: sorted.some((m) => m.provenance.piiLevel === 'public_source_may_contain_pii')
        ? 'public_source_may_contain_pii'
        : 'none_known',
    },
    mergedFrom: sorted.map((m) => m.recordId),
    sourceLabels: sorted.map((m) => m.source.label),
    perSource: sorted.map((m) => ({
      recordId: m.recordId,
      sourceId: m.source.id,
      sourceRecordId: m.source.sourceRecordId,
    })),
  };

  for (const key of ['conditionOrDisease', 'interventions', 'phase', 'sponsorOrInstitution', 'countries'] as const) {
    if (!merged[key] || (merged[key] as string[]).length === 0) delete merged[key];
  }
  if (!merged.dates || Object.keys(merged.dates).length === 0) delete merged.dates;
  delete merged.rawFields;

  return merged;
}

/** Source priority for choosing a group head: primary registries first. */
const SOURCE_PRIORITY: Record<SourceId, number> = {
  chinadrugtrials: 0,
  chictr_online: 1,
  ctv: 2,
  ictrp: 3,
  chictr_pancreatic_archive: 4,
  xyb_chinadrugtrials_archive: 5,
};

function compareCanonicalForHead(a: CanonicalTrialRecord, b: CanonicalTrialRecord): number {
  const pa = SOURCE_PRIORITY[a.source.id] ?? 99;
  const pb = SOURCE_PRIORITY[b.source.id] ?? 99;
  if (pa !== pb) return pa - pb;
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/**
 * Deterministic ordering: title presence, then title, then recordId. Callers
 * get a stable order without needing source-specific tie-breaks.
 */
export function compareCanonical(a: CanonicalTrialRecord, b: CanonicalTrialRecord): number {
  const ta = (a.title ?? a.publicTitle ?? '').trim();
  const tb = (b.title ?? b.publicTitle ?? '').trim();
  if (Boolean(ta) !== Boolean(tb)) return ta ? -1 : 1;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

export function describeOverlap(entry: OverlapEntry): string {
  return `${entry.registryNumber} 命中 ${entry.recordIds.length} 条记录`;
}
