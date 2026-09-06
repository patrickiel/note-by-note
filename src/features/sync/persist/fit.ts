import { songKey } from '../../../core/model/track-identity.ts';
import type { Backup } from '../../../core/persist/backup-codec.ts';
import type { HistoryEntry, TrackData, TrackIdentity } from '../../../core/model/types';

/**
 * Cuts a backup down to a byte budget — the browser's sync quota — by
 * dropping old things rather than capping counts. Nothing is trimmed while it
 * fits; when it doesn't, the cuttable things form one ordered list and the
 * shortest prefix of it that makes the rest fit is dropped:
 *
 *   1. songs that aren't favorited: their Recent row and track record, by
 *      how recently they were played or edited (orphan records — a song no
 *      longer in Recent — sit here by their own edit time);
 *   2. chord charts, by when they were computed (they can be re-analyzed);
 *   3. favorites, with their Recent row and track record, by last access.
 *
 * Each group oldest first. Settings, UI prefs and EQ presets are never cut.
 * Songs are matched the way the library does (`songKey`: URL + title), so a
 * record saved under a drifted duration still follows its favorite.
 *
 * `measure` is injected (and may be async): the caller decides what "size"
 * means — encoded JSON length in tests, the gzip+base64 blob for sync — so
 * this stays pure and runs under `node --test`; hence relative `.ts` imports.
 */

export interface FitResult {
  backup: Backup;
  /** Something had to go. */
  trimmed: boolean;
  /** `measure` of the returned backup. */
  size: number;
}

/** Thrown when even settings plus every favorite is over the budget. */
export class LibraryTooLargeError extends Error {
  constructor() {
    super("Your library is too large for the browser's sync storage.");
    this.name = 'LibraryTooLargeError';
  }
}

export const hasChart = (track: TrackData) =>
  !!track.chordChart && track.chordChart.segments.length > 0;

/** A song (by `songKey`, row + record) or a chart (by track key). */
interface Cut {
  kind: 'song' | 'chart';
  id: string;
  recency: number;
}

/** Oldest first; equal dates by id, so equal input cuts the same way. */
const oldestFirst = (a: Cut, b: Cut) =>
  a.recency - b.recency || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Everything that may go, in the order it goes. */
function collectCuts(backup: Backup): Cut[] {
  const favorites = new Set(backup.favorites.map((f) => songKey(f.identity)));
  const songs = new Map<string, number>();
  const touch = (identity: TrackIdentity, at: number) => {
    const id = songKey(identity);
    if (!favorites.has(id)) songs.set(id, Math.max(songs.get(id) ?? 0, at));
  };
  for (const entry of backup.history) touch(entry.identity, entry.updatedAt ?? 0);
  for (const track of backup.tracks) touch(track.identity, track.updatedAt ?? 0);

  const accessed = new Map<string, number>();
  for (const f of backup.favorites) {
    const id = songKey(f.identity);
    const at = f.lastAccessedAt ?? f.updatedAt ?? 0;
    accessed.set(id, Math.max(accessed.get(id) ?? 0, at));
  }

  const asCuts = (kind: Cut['kind'], m: Map<string, number>) =>
    [...m].map(([id, recency]) => ({ kind, id, recency })).sort(oldestFirst);
  const charts = backup.tracks
    .filter(hasChart)
    .map((t) => ({ kind: 'chart' as const, id: t.identity.key, recency: t.chordChart!.computedAt ?? 0 }))
    .sort(oldestFirst);
  return [...asCuts('song', songs), ...charts, ...asCuts('song', accessed)];
}

function apply(backup: Backup, cuts: Cut[]): Backup {
  const songs = new Set(cuts.filter((c) => c.kind === 'song').map((c) => c.id));
  const charts = new Set(cuts.filter((c) => c.kind === 'chart').map((c) => c.id));
  const keep = (row: HistoryEntry | TrackData) => !songs.has(songKey(row.identity));
  return {
    ...backup,
    history: backup.history.filter(keep),
    favorites: backup.favorites.filter(keep),
    tracks: backup.tracks
      .filter(keep)
      .map((t) => (charts.has(t.identity.key) ? { ...t, chordChart: null } : t)),
  };
}

/**
 * The largest backup, in the order above, whose `measure` is at most
 * `budget`. Deterministic for equal input. Throws `LibraryTooLargeError`
 * when nothing cuttable is left and it still doesn't fit.
 */
export async function fitBackup(
  backup: Backup,
  budget: number,
  measure: (backup: Backup) => number | Promise<number>,
): Promise<FitResult> {
  const size = await measure(backup);
  if (size <= budget) return { backup, trimmed: false, size };

  // Size only shrinks as more of the list goes, so binary-search the
  // shortest prefix that fits: `lo` is known not to, `hi` is known to.
  const cuts = collectCuts(backup);
  const sizeOf = (n: number) => measure(apply(backup, cuts.slice(0, n)));
  let lo = 0;
  let hi = cuts.length;
  let hiSize = await sizeOf(hi);
  if (hiSize > budget) throw new LibraryTooLargeError();
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const s = await sizeOf(mid);
    if (s <= budget) {
      hi = mid;
      hiSize = s;
    } else {
      lo = mid;
    }
  }
  return { backup: apply(backup, cuts.slice(0, hi)), trimmed: true, size: hiSize };
}
