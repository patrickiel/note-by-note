/**
 * Deletion records ("tombstones"): what the user removed, and when. Without
 * them a Recent row, a favorite or an EQ preset deleted on one device would
 * come straight back from another device's copy the next time the two merge —
 * a merge is a union, and it cannot tell "never had it" from "removed it".
 * Track records need none: an emptied record still exists, with a newer
 * `updatedAt`, and wins its merge on that.
 *
 * One flat map, `key → when` (ms). Keys: `h:<songKey>` a Recent row,
 * `f:<songKey>` a favorite, `h:*` "Clear Recent", `e:<name>` an EQ preset.
 * Songs are named by `songKey` (URL + title, no duration — see
 * track-identity.ts) so the record reaches every copy of the song, however
 * its duration drifted, exactly like the merge matches them. A record older
 * than the item it names (the song was played again, the preset saved again)
 * is ignored, so re-adding always works. Records expire after a month and are
 * capped, newest kept — long enough for any device that will ever sync again
 * to see them.
 *
 * Pure and DOM-free (relative `.ts` imports; runs under `node --test`).
 */

import type { Backup } from './backup-codec.ts';

export type Deletions = Record<string, number>;

export const historyDeletion = (songKey: string) => `h:${songKey}`;
export const favoriteDeletion = (songKey: string) => `f:${songKey}`;
export const presetDeletion = (name: string) => `e:${name}`;
export const HISTORY_CLEARED = 'h:*';

export const DELETION_TTL_MS = 30 * 24 * 60 * 60_000;
export const DELETION_CAP = 200;

/** Whether any of `keys` carries a deletion dated at or after `since` — the
 * item's own save time, so a later re-add always beats the record. */
export function deletedSince(deletions: Deletions, since: number, ...keys: string[]): boolean {
  return keys.some((key) => {
    const when = deletions[key] ?? 0;
    return when > 0 && when >= since;
  });
}

/** Newest date per key. */
export function mergeDeletions(a: Deletions, b: Deletions): Deletions {
  const out: Deletions = { ...a };
  for (const [key, when] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, when);
  return out;
}

/** Drops records older than the TTL and, past the cap, the oldest. */
export function pruneDeletions(deletions: Deletions, now: number): Deletions {
  const kept = Object.entries(deletions)
    .filter(([, when]) => typeof when === 'number' && Number.isFinite(when) && now - when < DELETION_TTL_MS)
    .sort(([, a], [, b]) => b - a)
    .slice(0, DELETION_CAP);
  return Object.fromEntries(kept);
}

/** Anything a file or a remote copy claims to be deletions, made safe. */
export function normalizeDeletions(raw: unknown): Deletions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(
    ([, when]) => typeof when === 'number' && Number.isFinite(when) && when > 0,
  ));
}

/** A manual import is a new edit. Keep deletion records for absent items,
 * but date restored items after them so the next sync cannot delete them. */
export function reviveBackup(backup: Backup, deletions: Deletions, now = Date.now()): Backup {
  const updatedAt = Math.max(now, backup.exportedAt, ...Object.values(deletions)) + 1;
  return {
    ...backup,
    exportedAt: updatedAt,
    history: backup.history.map((e) => ({ ...e, updatedAt })),
    favorites: backup.favorites.map((e) => ({ ...e, updatedAt })),
    eqPresets: backup.eqPresets.map((e) => ({ ...e, updatedAt })),
    tracks: backup.tracks.map((t) => ({
      ...t,
      updatedAt,
      chordChart: t.chordChart ? { ...t.chordChart, computedAt: updatedAt } : t.chordChart,
    })),
    deletions,
  };
}
