import { HISTORY_LIMIT } from '../../../core/model/defaults.ts';
import type { HistoryEntry, TrackData } from '../../../core/model/types.ts';
import {
  HISTORY_CLEARED,
  historyDeletion,
  isDeleted,
  trackDeletion,
  type Deletions,
} from '../../../core/persist/deletions.ts';
import { decodeTrack, type CompactTrackData } from './sync-snapshot.ts';

/**
 * How a remote snapshot is merged into this device's Recent and per-track
 * records. Both are trimmable on the sender's side (`fit.ts`), so an item
 * the remote lacks is *unknown* to it, not gone: it is kept here unless the
 * remote's deletion records say otherwise (`core/persist/deletions.ts`).
 * The check runs both ways — a remote copy this device already deleted is
 * not taken back either.
 *
 * Pure: runs under `node --test`, hence the relative `.ts` imports.
 */

interface Keyed {
  identity: { key: string };
  updatedAt: number;
}

/** Per key, the newer copy wins (ties to the remote). A copy the other side
 * deleted since its edit is out of the running — so a stale remote copy of
 * something deleted and re-created here neither comes back nor shadows the
 * re-creation. `cleared` also honours the "Clear Recent" record. */
function mergeByKey<T extends Keyed>(
  remote: T[],
  local: T[],
  remoteDeleted: Deletions,
  localDeleted: Deletions,
  deletionKey: (key: string) => string,
  cleared = false,
): T[] {
  const gone = (d: Deletions, item: T) =>
    isDeleted(d, deletionKey(item.identity.key), item.updatedAt) ||
    (cleared && isDeleted(d, HISTORY_CLEARED, item.updatedAt));
  const kept = new Map<string, T>();
  for (const e of remote) if (!gone(localDeleted, e)) kept.set(e.identity.key, e);
  for (const e of local) {
    if (gone(remoteDeleted, e)) continue;
    const r = kept.get(e.identity.key);
    if (!r || e.updatedAt > r.updatedAt) kept.set(e.identity.key, e);
  }
  return [...kept.values()];
}

/** Newest first, capped like the store. Twins of one song under two
 * durations are collapsed at the next panel boot (`dedupeHistory`), which an
 * apply triggers. */
export function mergeHistory(
  remote: HistoryEntry[],
  local: HistoryEntry[],
  remoteDeleted: Deletions,
  localDeleted: Deletions,
): HistoryEntry[] {
  return mergeByKey(remote, local, remoteDeleted, localDeleted, historyDeletion, true)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HISTORY_LIMIT);
}

/** The records to keep. A remote record without a chart takes this device's
 * chart for that track (absent may mean trimmed); the caller removes every
 * local record not returned. */
export function mergeTracks(
  remote: CompactTrackData[],
  local: TrackData[],
  remoteDeleted: Deletions,
  localDeleted: Deletions,
): TrackData[] {
  const mine = new Map(local.map((t) => [t.identity.key, t]));
  const decoded = remote.map((r): TrackData => {
    const own = mine.get(r.identity.key);
    const track = decodeTrack(r);
    if (!r.chart) track.chordChart = own?.chordChart ?? null;
    const chordsEnabled = r.chordsEnabled ?? own?.chordsEnabled;
    if (chordsEnabled !== undefined) track.chordsEnabled = chordsEnabled;
    return track;
  });
  return mergeByKey(decoded, local, remoteDeleted, localDeleted, trackDeletion);
}
