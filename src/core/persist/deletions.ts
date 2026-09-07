/**
 * How a deletion travels between devices.
 *
 * A merge is a union, and a union cannot tell "never had it" from "removed
 * it". So a removed row is not dropped: it stays in its own list, marked
 * `deleted` and dated when the user removed it. That is a tombstone, and it
 * is an ordinary row — which is the whole point:
 *
 *   - the merge needs no deletion rules of its own. Last write wins, and a
 *     tombstone is a write (`merge.ts`);
 *   - re-adding works by itself: the new row simply out-dates the tombstone;
 *   - a deletion can only ever reach the item it *is*, so it cannot misfire
 *     on a song, preset or record it was never about;
 *   - the codec, the fit and the backup file carry it with everything else.
 *
 * Track records need no tombstone: an emptied record still exists, with a
 * newer date, and wins its merge on that.
 *
 * The panel stores filter tombstones out, so nothing downstream sees one.
 * They expire after a month — long enough for any device that will ever sync
 * again to have seen them — and `pruneTombstones` drops them at merge and
 * restore time.
 *
 * Pure and DOM-free (relative `.ts` imports; runs under `node --test`).
 */

import type { Backup } from './backup-codec.ts';
import type { HistoryEntry } from '../model/types';

export const DELETION_TTL_MS = 30 * 24 * 60 * 60_000;

/** A row a merge dates and can tombstone. */
export interface Deletable {
  updatedAt?: number;
  deleted?: true;
}

/** The one date every merge decision reads: when this row last changed — was
 * written, or was removed. */
export const at = (item: Deletable) => item.updatedAt ?? 0;

export const isLive = (item: Deletable) => item.deleted !== true;

/** The row, kept but marked removed as of `now`. */
export const tombstone = <T extends Deletable>(item: T, now: number): T => ({
  ...item,
  updatedAt: now,
  deleted: true,
});

/** Drops tombstones past the TTL. Live rows are never touched. */
export const pruneTombstones = <T extends Deletable>(list: T[], now: number): T[] =>
  list.filter((item) => isLive(item) || now - at(item) < DELETION_TTL_MS);

const song = (entry: HistoryEntry) => entry.identity.key;

/**
 * A replacement import, as items: the file's contents dated now, plus a
 * tombstone for everything this device held that the file leaves out.
 *
 * Deliberately a *local* operation — it removes what this device had, which
 * is what the import prompt promises. A song only another device knows about
 * is not this import's to delete, and there is no "everything before now is
 * gone" record that could reach one: a date range cannot be made safe across
 * two clocks, and every list dates its rows for its own reasons.
 *
 * Track records are not tombstoned either. The songs that named them are, so
 * the records go quiet; a record another device still holds costs a few bytes
 * (the first thing `fit.ts` cuts) and erring towards keeping markers is the
 * right way round.
 *
 * `current` is this device's data as `createBackup` reads it.
 */
export function replaceAll(file: Backup, current: Backup, now = Date.now()): Backup {
  const held = [...current.history, ...current.favorites, ...current.eqPresets];
  // Revived rows have to out-date every tombstone in play, this device's and
  // any another device's clock dated ahead of ours.
  const revivedAt =
    Math.max(now, file.exportedAt ?? 0, ...held.filter((i) => !isLive(i)).map(at)) + 1;

  /** Tombstones for the live rows of `before` that `kept` does not carry,
   * plus the tombstones `before` already had for anything else. */
  const removed = <T extends Deletable>(before: T[], kept: T[], id: (item: T) => string): T[] => {
    const keys = new Set(kept.map(id));
    return before
      .filter((item) => !keys.has(id(item)))
      .map((item) => (isLive(item) ? tombstone(item, now) : item));
  };
  const revived = <T extends Deletable>(list: T[]): T[] =>
    list.map((item) => ({ ...item, updatedAt: revivedAt }));
  const byName = (preset: { name: string }) => preset.name;

  return {
    ...file,
    exportedAt: revivedAt,
    settings: { ...file.settings, updatedAt: revivedAt },
    uiPrefs: { ...file.uiPrefs, updatedAt: revivedAt },
    history: [
      ...revived(file.history),
      ...removed(current.history, file.history, song),
    ],
    favorites: [
      // The imported order is the newest statement about it, too.
      ...revived(file.favorites).map((f) => ({ ...f, orderedAt: revivedAt })),
      ...removed(current.favorites, file.favorites, song),
    ],
    eqPresets: [
      ...revived(file.eqPresets),
      ...removed(current.eqPresets, file.eqPresets, byName),
    ],
    tracks: revived(file.tracks).map((track) => ({
      ...track,
      chordChart: track.chordChart
        ? { ...track.chordChart, computedAt: revivedAt }
        : track.chordChart,
    })),
  };
}
