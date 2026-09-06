/**
 * Deletion records ("tombstones"): what the user removed, and when. Without
 * them a Recent row or a favorite deleted on one device would come straight
 * back from another device's copy the next time the two merge — a merge is a
 * union, and it cannot tell "never had it" from "removed it". Track records
 * need none: an emptied record still exists, with a newer `updatedAt`, and
 * wins its merge on that.
 *
 * One flat map, `key → when` (ms). Keys: `h:<identity.key>` a Recent row,
 * `f:<identity.key>` a favorite, `h:*` "Clear Recent". A record older than the
 * item it names (the song was played again after the deletion) is ignored, so
 * re-adding always works. Records expire after a month and are capped, newest
 * kept — long enough for any device that will ever sync again to see them.
 *
 * Pure and DOM-free (relative `.ts` imports; runs under `node --test`).
 */

export type Deletions = Record<string, number>;

export const historyDeletion = (key: string) => `h:${key}`;
export const favoriteDeletion = (key: string) => `f:${key}`;
export const HISTORY_CLEARED = 'h:*';

export const DELETION_TTL_MS = 30 * 24 * 60 * 60_000;
export const DELETION_CAP = 200;

/** When `key` was deleted, or 0 if it wasn't. */
export function deletedAt(deletions: Deletions, key: string): number {
  return deletions[key] ?? 0;
}

/** Whether a Recent row with `updatedAt` is covered by a deletion — its own
 * or a "Clear Recent" — dated at or after it. */
export function historyDeleted(deletions: Deletions, key: string, updatedAt: number): boolean {
  const when = Math.max(deletedAt(deletions, historyDeletion(key)), deletedAt(deletions, HISTORY_CLEARED));
  return when > 0 && when >= updatedAt;
}

export function favoriteDeleted(deletions: Deletions, key: string, since: number): boolean {
  const when = deletedAt(deletions, favoriteDeletion(key));
  return when > 0 && when >= since;
}

/** Newest date per key. */
export function mergeDeletions(a: Deletions, b: Deletions): Deletions {
  const out: Deletions = { ...a };
  for (const [key, when] of Object.entries(b)) {
    if (typeof when !== 'number') continue;
    out[key] = Math.max(out[key] ?? 0, when);
  }
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
  const out: Deletions = {};
  for (const [key, when] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof when === 'number' && Number.isFinite(when) && when > 0) out[key] = when;
  }
  return out;
}
