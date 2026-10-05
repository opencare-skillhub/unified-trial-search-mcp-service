/**
 * Adapter factory (SPEC 6.1).
 *
 * The registry is closed: which sources exist is decided here, in host-owned
 * code, never by a caller. Each adapter is instantiated once and shared, so
 * per-source state (the ChiCTR serialized request chain, ...) is preserved.
 *
 * A missing runtime dependency is not a construction failure: every adapter
 * reports its own readiness through `getStatus`, so `doctor` can show a full
 * picture of a partially initialized environment.
 */

import type { ResolvedPaths, SecretAccessor, SourceId, TrialSourceAdapter } from '../core/types.js';
import { SOURCE_IDS } from '../core/registry.js';
import { IctrpAdapter } from './ictrp.js';
import { CtvAdapter } from './ctv.js';
import { ChictrOnlineAdapter } from './chictr-online.js';
import { ChictrPancreaticAdapter } from './chictr-pancreatic.js';
import { ChinaDrugTrialsAdapter } from './chinadrugtrials.js';
import { XybArchiveAdapter } from './xyb-archive.js';

export interface FactoryOptions {
  paths: ResolvedPaths;
  secrets: SecretAccessor;
}

export interface AdapterBundle {
  adapters: Map<SourceId, TrialSourceAdapter>;
  paths: ResolvedPaths;
  secrets: SecretAccessor;
}

export function createAdapters(options: FactoryOptions): AdapterBundle {
  const adapters = new Map<SourceId, TrialSourceAdapter>();

  for (const id of SOURCE_IDS) {
    switch (id) {
      case 'ictrp':
        adapters.set(id, new IctrpAdapter());
        break;
      case 'ctv':
        adapters.set(id, new CtvAdapter());
        break;
      case 'chictr_online':
        adapters.set(id, new ChictrOnlineAdapter());
        break;
      case 'chictr_pancreatic_archive':
        adapters.set(id, new ChictrPancreaticAdapter());
        break;
      case 'chinadrugtrials':
        adapters.set(id, new ChinaDrugTrialsAdapter());
        break;
      case 'xyb_chinadrugtrials_archive':
        adapters.set(id, new XybArchiveAdapter());
        break;
    }
  }

  return { adapters, paths: options.paths, secrets: options.secrets };
}

/** Resolves one adapter; used by the detail/evidence/maintenance tools. */
export function adapterFor(bundle: AdapterBundle, id: SourceId): TrialSourceAdapter | undefined {
  return bundle.adapters.get(id);
}

/** True when the source is registered in the closed registry. */
export function hasAdapter(bundle: AdapterBundle, id: string): id is SourceId {
  return bundle.adapters.has(id as SourceId);
}
