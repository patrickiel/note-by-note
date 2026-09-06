import { isRecord } from './backup-format.ts';

/**
 * Deletion records, so sync can tell "deleted here" from "left out to fit
 * the quota". The snapshot that travels may omit a per-track record or a
 * Recent row purely for size (`features/sync/persist/fit.ts`), and the
 * receiver keeps whatever it already has for anything absent — which would
 * also quietly undo every deletion, and let another device re-upload the
 * deleted item later. A deletion therefore leaves a dated record behind; it
 * travels in tier 1 (never trimmed) and kills a copy elsewhere whose
 * `updatedAt` is not newer than the deletion. Anything edited after it
 * survives — that is a re-creation, not a resurrection.
 *
 * Bounded by age and count so the tier stays small: past the TTL a copy
 * could only come back from a device that has not synced in a month.
 *
 * Pure: runs under `node --test`, hence the relative `.ts` import.
 */

/** Deletion key → when. Keys are `track:<identity.key>` (the per-track
 * record's last marker or snippet removed), `history:<identity.key>` (a
 * Recent row removed) and `history:*` ("Clear Recent" — every row not edited
 * since is gone). */
export type Deletions = Record<string, number>;

export const trackDeletion = (key: string) => `track:${key}`;
export const historyDeletion = (key: string) => `history:${key}`;
export const HISTORY_CLEARED = 'history:*';

export const DELETION_TTL_MS = 30 * 24 * 60 * 60_000;
/** ~50 bytes a record before gzip; the cap keeps tier 1 bounded. */
export const DELETION_CAP = 200;

/** True when the deletion at `key` is at least as new as the copy dated
 * `updatedAt` — the copy predates the deletion and must go. */
export function isDeleted(d: Deletions, key: string, updatedAt: number): boolean {
  const at = d[key];
  return at !== undefined && at >= updatedAt;
}

/** Drops records older than the TTL and keeps the newest `DELETION_CAP`. */
export function pruneDeletions(d: Deletions, now = Date.now()): Deletions {
  const kept = Object.entries(d)
    .filter(([, at]) => now - at < DELETION_TTL_MS)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, DELETION_CAP);
  return Object.fromEntries(kept);
}

/** The later record wins per key, so a device learns a deletion from
 * whichever peer it hears about it from and carries it on. */
export function mergeDeletions(a: Deletions, b: Deletions): Deletions {
  const out = { ...a };
  for (const [key, at] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, at);
  return out;
}

/** Loose validation: an older sender or file carries none. */
export function normalizeDeletions(raw: unknown): Deletions {
  if (!isRecord(raw)) return {};
  const out: Deletions = {};
  for (const [key, at] of Object.entries(raw)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[key] = at;
  }
  return out;
}
