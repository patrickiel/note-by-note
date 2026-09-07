import { HISTORY_LIMIT } from '../../../core/model/defaults.ts';
import { songKey } from '../../../core/model/track-identity.ts';
import type { Backup } from '../../../core/persist/backup-codec.ts';
import {
  deletedSince,
  favoriteDeletion,
  HISTORY_CLEARED,
  historyDeletion,
  mergeDeletions,
  presetDeletion,
  pruneDeletions,
  REPLACED_ALL,
} from '../../../core/persist/deletions.ts';
import type { FavoriteEntry, HistoryEntry } from '../../../core/model/types';

/**
 * Two devices' libraries into one. A union, item by item, so a copy another
 * device trimmed to fit the quota never deletes anything here, and edits made
 * on both sides since they last met both survive:
 *
 *   - Recent rows and favorites: matched by song (URL + title, like the
 *     library itself), the more recently updated one wins; a dated deletion
 *     (`deletions.ts`) beats any copy it postdates. A favorite's last access
 *     is the later of the two.
 *   - Track records: matched by key, the more recently edited wins outright —
 *     an emptied record is still a record, so clearing markers sticks. A
 *     chart is chosen separately by computedAt: null may mean "trimmed", but
 *     an empty, dated chart is an explicit deletion and beats older analysis.
 *   - Settings and UI prefs: the newer device's, as a whole. EQ presets: union
 *     by name, the later save of a shared name, deletions honoured.
 *   - Last, the two library copies of a song (Recent and Favorites) are put
 *     back in step: they are written together and read as one.
 *
 * `remoteWins` breaks ties and picks the wholesale sections: true when the
 * remote copy was written after this device's last local change. The winning
 * side's order comes first in every list. Pure; `node --test`.
 */

const at = (item: { updatedAt?: number }) => item.updatedAt ?? 0;

/** Union by `id`: of two copies the later `updatedAt` wins (the first list's
 * on a tie), `dead` ones are skipped, and `resolve` can fold the loser's
 * fields into the winner. First list's order, then the second's extras. */
function unionNewest<T extends { updatedAt?: number }>(
  first: T[],
  second: T[],
  id: (item: T) => string,
  dead: (item: T) => boolean = () => false,
  resolve: (winner: T, loser: T) => T = (winner) => winner,
): T[] {
  const byId = new Map<string, T>();
  for (const item of [...first, ...second]) {
    if (dead(item)) continue;
    const key = id(item);
    const current = byId.get(key);
    if (!current) byId.set(key, item);
    else byId.set(key, at(item) > at(current) ? resolve(item, current) : resolve(current, item));
  }
  return [...byId.values()];
}

const song = (entry: HistoryEntry) => songKey(entry.identity);

/** Newest first, down to `HISTORY_LIMIT` — but only non-favorited rows are
 * ever dropped. A favorited song whose Recent row went would leave the two
 * library copies of it disagreeing, which is the drift `upsertHistory` and
 * `fit.ts` both go out of their way to prevent; a union of two full libraries
 * is exactly where the cap would otherwise reach one. Over the limit in
 * favorites alone, the list simply stays long. */
function capHistory(history: HistoryEntry[], favorites: FavoriteEntry[]): HistoryEntry[] {
  const ordered = history.sort((a, b) => at(b) - at(a));
  const excess = ordered.length - HISTORY_LIMIT;
  if (excess <= 0) return ordered;
  const favorited = new Set(favorites.map((f) => song(f)));
  const cut = new Set(ordered.filter((e) => !favorited.has(song(e))).slice(-excess));
  return ordered.filter((e) => !cut.has(e));
}

/** Recent and Favorites each hold a copy of the same song's settings and are
 * written together (`track-sync.#saveCurrent`); `findSavedEntry` and the chips
 * in the list both take the two to agree. Merged apart they drift — star a song
 * on one device, practise it unstarred on another, and only Recent hears about
 * the new settings — so both copies take the newer one's params. Dates are left
 * alone: this is a function of the merged lists, so every device works out the
 * same answer from the same pair of copies. */
function alignParams(history: HistoryEntry[], favorites: FavoriteEntry[]) {
  const newest = new Map<string, HistoryEntry>();
  for (const entry of [...history, ...favorites]) {
    const best = newest.get(song(entry));
    if (!best || at(entry) > at(best)) newest.set(song(entry), entry);
  }
  return <T extends HistoryEntry>(entry: T): T => {
    const best = newest.get(song(entry));
    return best && best !== entry ? { ...entry, params: best.params } : entry;
  };
}

export function mergeBackups(
  local: Backup,
  remote: Backup,
  remoteWins: boolean,
  now = Date.now(),
): Backup {
  const [winner, loser] = remoteWins ? [remote, local] : [local, remote];
  const deletions = pruneDeletions(mergeDeletions(local.deletions ?? {}, remote.deletions ?? {}), now);
  const history = unionNewest(winner.history, loser.history, song, (e) =>
    deletedSince(deletions, at(e), historyDeletion(song(e)), HISTORY_CLEARED, REPLACED_ALL),
  );
  const favorites = unionNewest(
    winner.favorites,
    loser.favorites,
    song,
    // Anchored on `favoritedAt` — when the star was put there — not on
    // `updatedAt`, which ordinary practice bumps (`touchFavorite` with new
    // params). Taking the later of the two would let a slider nudge on one
    // device outdate the other's unfavorite and re-star the song.
    (f) => deletedSince(deletions, f.favoritedAt || at(f), favoriteDeletion(song(f)), REPLACED_ALL),
    (w, l): FavoriteEntry => ({
      ...w,
      lastAccessedAt: Math.max(w.lastAccessedAt ?? 0, l.lastAccessedAt ?? 0),
    }),
  );
  const align = alignParams(history, favorites);
  return {
    ...local,
    exportedAt: Math.max(local.exportedAt ?? 0, remote.exportedAt ?? 0),
    settings: winner.settings,
    uiPrefs: winner.uiPrefs,
    eqPresets: unionNewest(
      winner.eqPresets,
      loser.eqPresets,
      (p) => p.name,
      (p) => deletedSince(deletions, at(p), presetDeletion(p.name), REPLACED_ALL),
    ),
    history: capHistory(history.map(align), favorites),
    favorites: favorites.map(align),
    tracks: unionNewest(
      winner.tracks,
      loser.tracks,
      (t) => t.identity.key,
      // No tombstone of their own (an emptied record is one), but a
      // replacement import drops markers and snippets too.
      (t) => deletedSince(deletions, at(t), REPLACED_ALL),
      (w, l) => ({
        ...w,
        chordChart: !w.chordChart || (l.chordChart?.computedAt ?? 0) > w.chordChart.computedAt
          ? l.chordChart ?? w.chordChart
          : w.chordChart,
      }),
    ),
    deletions,
  };
}
