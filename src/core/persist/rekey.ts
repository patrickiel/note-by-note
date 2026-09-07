import { songKey } from '../model/track-identity.ts';
import type { TrackIdentity } from '../model/types';

/**
 * Re-deriving stored keys, for the one-time migration in `library-migration.ts`.
 *
 * Pure and DOM-free (relative `.ts` imports; runs under `node --test`) because
 * it is the one step of that migration that can lose data: rows a key change
 * brings together have to be collapsed, and the right copy has to survive.
 */

export interface Keyed {
  identity: TrackIdentity;
  updatedAt?: number;
}

const at = (row: Keyed) => row.updatedAt ?? 0;

/**
 * Rows under the key `songKey` derives from them now, with copies that land on
 * the same key collapsed to the most recently written one — a song saved under
 * two durations was always one song, and this is where its copies finally meet.
 *
 * List order is kept (Recent is newest-first, Favorites is the manual order): a
 * survivor takes the position of the first copy seen, not of the copy that won.
 * Rows without a usable identity are dropped rather than given a key derived
 * from `undefined`, which would collide every one of them into a single row.
 */
export function rekeyByIdentity<T extends Keyed>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    if (typeof row?.identity?.normalizedUrl !== 'string') continue;
    const key = songKey(row.identity);
    const next = { ...row, identity: { ...row.identity, key } };
    const current = byKey.get(key);
    if (!current || at(next) >= at(current)) byKey.set(key, next);
  }
  return [...byKey.values()];
}
