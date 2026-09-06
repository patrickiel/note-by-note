import type { Backup } from '../../../core/persist/backup-codec.ts';
import type { FavoriteEntry, HistoryEntry, TrackData, TrackIdentity } from '../../../core/model/types';

/**
 * Cuts a backup down to a byte budget — the browser's sync quota — by
 * dropping old things rather than capping counts. Nothing is trimmed while it
 * fits; when it doesn't, tiers go in this order, each from its oldest end,
 * and each cut no deeper than needed:
 *
 *   1. songs that aren't favorited: their Recent row and track record, by
 *      how recently they were played or edited (orphan records — a song no
 *      longer in Recent — sit in this tier by their own edit time);
 *   2. chord charts, by when they were computed (they can be re-analyzed);
 *   3. favorites, with their Recent row and track record, by last access.
 *
 * Settings, UI prefs and EQ presets are never cut. Songs are matched the way
 * the library does (`isSameTrack`), so a record saved under a drifted
 * duration still follows its favorite.
 *
 * `measure` is injected: the caller decides what "size" means (encoded JSON
 * length in tests, the gzip+base64 blob for sync), so this stays pure and
 * runs under `node --test` — hence relative `.ts` imports.
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

/** How many of each tier's items (newest first) the built backup keeps. */
interface Plan {
  songs: number;
  charts: number;
  favorites: number;
}

const TIERS: readonly (keyof Plan)[] = ['songs', 'charts', 'favorites'];

/** The library matches rows by song, not key — see `isSameTrack`. */
const songId = (identity: TrackIdentity) => `${identity.normalizedUrl}\n${identity.title}`;

const byRecency = (a: { recency: number; key: string }, b: { recency: number; key: string }) =>
  b.recency - a.recency || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const hasChart = (track: TrackData) => !!track.chordChart && track.chordChart.segments.length > 0;

interface Tiers {
  /** Non-favorited songs, newest first. */
  songs: { id: string; recency: number; key: string }[];
  /** Chart-bearing track records, newest chart first. */
  charts: { key: string; recency: number }[];
  /** Favorites' songs, most recently accessed first. */
  favorites: { id: string; recency: number; key: string }[];
}

function collectTiers(backup: Backup): Tiers {
  const favoriteIds = new Set(backup.favorites.map((f) => songId(f.identity)));
  const songs = new Map<string, { id: string; recency: number; key: string }>();
  const touch = (identity: TrackIdentity, recency: number) => {
    const id = songId(identity);
    if (favoriteIds.has(id)) return;
    const current = songs.get(id);
    if (!current) songs.set(id, { id, recency, key: identity.key });
    else current.recency = Math.max(current.recency, recency);
  };
  for (const entry of backup.history) touch(entry.identity, entry.updatedAt ?? 0);
  for (const track of backup.tracks) touch(track.identity, track.updatedAt ?? 0);

  const charts = backup.tracks
    .filter(hasChart)
    .map((t) => ({ key: t.identity.key, recency: t.chordChart!.computedAt ?? 0 }))
    .sort(byRecency);

  const favorites = new Map<string, { id: string; recency: number; key: string }>();
  for (const f of backup.favorites) {
    const id = songId(f.identity);
    const recency = f.lastAccessedAt ?? f.updatedAt ?? 0;
    const current = favorites.get(id);
    if (!current) favorites.set(id, { id, recency, key: f.identity.key });
    else current.recency = Math.max(current.recency, recency);
  }

  return {
    songs: [...songs.values()].sort(byRecency),
    charts,
    favorites: [...favorites.values()].sort(byRecency),
  };
}

function build(backup: Backup, tiers: Tiers, plan: Plan): Backup {
  const kept = new Set<string>();
  for (const s of tiers.songs.slice(0, plan.songs)) kept.add(s.id);
  for (const f of tiers.favorites.slice(0, plan.favorites)) kept.add(f.id);
  const keptCharts = new Set(tiers.charts.slice(0, plan.charts).map((c) => c.key));

  const keepRow = (row: HistoryEntry | FavoriteEntry) => kept.has(songId(row.identity));
  const tracks: TrackData[] = [];
  for (const track of backup.tracks) {
    if (!kept.has(songId(track.identity))) continue;
    if (hasChart(track) && !keptCharts.has(track.identity.key)) {
      tracks.push({ ...track, chordChart: null });
    } else {
      tracks.push(track);
    }
  }
  return {
    ...backup,
    history: backup.history.filter(keepRow),
    favorites: backup.favorites.filter(keepRow),
    tracks,
  };
}

/**
 * The largest backup, in the tier order above, whose `measure` is at most
 * `budget`. Deterministic for equal input. Throws `LibraryTooLargeError`
 * when nothing cuttable is left and it still doesn't fit.
 */
export function fitBackup(
  backup: Backup,
  budget: number,
  measure: (backup: Backup) => number,
): FitResult {
  const tiers = collectTiers(backup);
  const full: Plan = {
    songs: tiers.songs.length,
    charts: tiers.charts.length,
    favorites: tiers.favorites.length,
  };
  const size = measure(backup);
  if (size <= budget) return { backup, trimmed: false, size };

  const plan = { ...full };
  const sizeOf = (p: Plan) => measure(build(backup, tiers, p));
  for (const tier of TIERS) {
    // Earlier tiers are already empty. Does emptying this one fit?
    const empty = sizeOf({ ...plan, [tier]: 0 });
    if (empty > budget) {
      plan[tier] = 0;
      continue;
    }
    // Yes — keep as many of its newest items as still fit.
    let lo = 0; // known to fit
    let hi = plan[tier]; // known not to fit (full plan didn't)
    let loSize = empty;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const s = sizeOf({ ...plan, [tier]: mid });
      if (s <= budget) {
        lo = mid;
        loSize = s;
      } else {
        hi = mid;
      }
    }
    plan[tier] = lo;
    return { backup: build(backup, tiers, plan), trimmed: true, size: loSize };
  }
  throw new LibraryTooLargeError();
}
