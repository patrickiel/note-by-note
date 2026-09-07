import { HISTORY_LIMIT } from '../../../core/model/defaults.ts';
import { songKey } from '../../../core/model/track-identity.ts';
import type { Backup } from '../../../core/persist/backup-codec.ts';
import { at, isLive, pruneTombstones, type Deletable } from '../../../core/persist/deletions.ts';
import type { FavoriteEntry, HistoryEntry } from '../../../core/model/types';

/**
 * Two devices' libraries into one.
 *
 * One rule, applied to every list: union by id, and of two copies keep the one
 * with the later date. A deletion is a row like any other (`deletions.ts`), so
 * "removed over there" needs no case of its own, and neither does a re-add —
 * it is simply newer. Ties go to the tombstone.
 *
 *   - Recent rows and favorites: matched by song (URL + title, like the
 *     library itself), so a copy saved under a drifted duration is the same
 *     song. A favorite's last access is the later of the two.
 *   - Track records: matched by key. An emptied record is still a record, so
 *     clearing markers sticks. A chart is chosen separately by `computedAt`:
 *     null may mean "trimmed", but an empty, dated chart is an explicit
 *     deletion and beats older analysis.
 *   - Settings and UI prefs: one item each, with one date, taken whole.
 *     EQ presets: union by name.
 *   - Last, the two library copies of a song (Recent and Favorites) are put
 *     back in step: they are written together and read as one.
 *
 * **A pure function of its two inputs.** It asks this device nothing about
 * itself — no clock, no "which side am I on" — so both devices compute the
 * same answer and the second one has nothing left to push. That is what stops
 * two devices trading rival merges for ever, and it is why each list's *order*
 * comes out of the rows as well (`orderOf`): a rule like "keep my order, then
 * add theirs" reads the same on both devices and means something different on
 * each. `node --test`.
 */

const song = (entry: HistoryEntry) => songKey(entry.identity);

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Key-order-independent text of a value. Only ever used to break a tie, and
 * only so that both devices break it the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Which of two copies of one item survives: the later date; on a tie the
 * tombstone, because a removal and a re-add stamped in the same millisecond
 * have to resolve the same way on both devices; failing that the one whose
 * content sorts first, for the same reason. */
function wins<T extends Deletable>(item: T, current: T): boolean {
  if (at(item) !== at(current)) return at(item) > at(current);
  if (isLive(item) !== isLive(current)) return !isLive(item);
  return compare(canonical(item), canonical(current)) < 0;
}

/** Union by `id`, keeping the winner of each pair; `resolve` folds the loser's
 * fields into it. Unordered — every caller sorts the result. */
function unionNewest<T extends Deletable>(
  first: T[],
  second: T[],
  id: (item: T) => string,
  resolve: (winner: T, loser: T) => T = (winner) => winner,
): T[] {
  const byId = new Map<string, T>();
  for (const item of [...first, ...second]) {
    const key = id(item);
    const current = byId.get(key);
    if (!current) byId.set(key, item);
    else byId.set(key, wins(item, current) ? resolve(item, current) : resolve(current, item));
  }
  return [...byId.values()];
}

/** Newest-first by `date`, ties by id. Every merged list is ordered by
 * something each row carries, never by which copy it came from — that is what
 * makes the order the same on both devices, and stable when a third merge
 * runs over the result. */
const orderOf = <T>(date: (item: T) => number, id: (item: T) => string) => (a: T, b: T) =>
  date(b) - date(a) || compare(id(a), id(b));

/** Where a favorite sits in the manual order. `setFavoritesOrder` stamps the
 * row's rank into it (`now - index`, so the list reads back highest first) and
 * a new star takes `now`, which puts it on top. Rows from before manual order
 * synced fall back to the star date — near enough to the order they were
 * added in, which is the order they had. */
const rankOf = (f: FavoriteEntry) => f.orderedAt ?? f.favoritedAt ?? at(f);

/** Newest first, live rows down to `HISTORY_LIMIT` — but only non-favorited
 * rows are ever dropped. A favorited song whose Recent row went would leave
 * the two library copies of it disagreeing, which is the drift `upsertHistory`
 * and `fit.ts` both go out of their way to prevent; a union of two full
 * libraries is exactly where the cap would otherwise reach one. Over the limit
 * in favorites alone, the list simply stays long. Tombstones are kept whatever
 * the count — they go by age, not by rank. */
function capHistory(history: HistoryEntry[], favorites: FavoriteEntry[]): HistoryEntry[] {
  const ordered = [...history].sort(orderOf(at, song));
  const live = ordered.filter(isLive);
  const excess = live.length - HISTORY_LIMIT;
  if (excess <= 0) return ordered;
  const favorited = new Set(favorites.filter(isLive).map(song));
  const cut = new Set(live.filter((e) => !favorited.has(song(e))).slice(-excess));
  return ordered.filter((e) => !cut.has(e));
}

/** Recent and Favorites each hold a copy of the same song's settings and are
 * written together (`track-sync.#saveCurrent`); `findSavedEntry` and the chips
 * in the list both take the two to agree. The favorite's copy is a cache —
 * `touchFavorite` refreshes it without dating the row, so ordinary practice
 * can't outrank another device's unfavorite — and this is where the cache is
 * refilled: both copies take the fields of whichever row was written last. A
 * function of the merged lists, so every device works out the same answer from
 * the same pair of copies. */
function alignCopies(history: HistoryEntry[], favorites: FavoriteEntry[]) {
  const newest = new Map<string, HistoryEntry>();
  for (const entry of [...history, ...favorites]) {
    if (!isLive(entry)) continue;
    const best = newest.get(song(entry));
    if (!best || at(entry) > at(best)) newest.set(song(entry), entry);
  }
  return <T extends HistoryEntry>(entry: T): T => {
    const best = newest.get(song(entry));
    if (!best || best === entry || !isLive(entry)) return entry;
    // A copy, not the same object: the two lists are written and encoded
    // separately, and nothing here should be able to edit both at once.
    const aligned: T = { ...entry, params: { ...best.params }, pageUrl: best.pageUrl };
    if (best.thumbnailUrl === undefined) delete aligned.thumbnailUrl;
    else aligned.thumbnailUrl = best.thumbnailUrl;
    return aligned;
  };
}

/** Settings and UI prefs travel whole, as one item with one date. */
const newer = <T extends Deletable>(a: T, b: T): T => (wins(b, a) ? b : a);

export function mergeBackups(local: Backup, remote: Backup, now = Date.now()): Backup {
  const history = pruneTombstones(unionNewest(local.history, remote.history, song), now);
  const favorites = pruneTombstones(
    unionNewest(local.favorites, remote.favorites, song, (winner, loser) => ({
      ...winner,
      lastAccessedAt: Math.max(winner.lastAccessedAt ?? 0, loser.lastAccessedAt ?? 0),
      orderedAt: Math.max(winner.orderedAt ?? 0, loser.orderedAt ?? 0),
    })),
    now,
  ).sort(orderOf(rankOf, song));

  const byName = (preset: { name: string }) => preset.name;
  const align = alignCopies(history, favorites);
  return {
    ...local,
    exportedAt: Math.max(local.exportedAt ?? 0, remote.exportedAt ?? 0),
    settings: newer(local.settings, remote.settings),
    uiPrefs: newer(local.uiPrefs, remote.uiPrefs),
    // By name: the dropdown's order has to be the same on both devices, and
    // "the order they were saved in" is not something the rows can say.
    eqPresets: pruneTombstones(unionNewest(local.eqPresets, remote.eqPresets, byName), now)
      .sort((a, b) => compare(a.name, b.name)),
    history: capHistory(history.map(align), favorites),
    favorites: favorites.map(align),
    tracks: unionNewest(local.tracks, remote.tracks, (t) => t.identity.key, (w, l) => ({
      ...w,
      chordChart:
        !w.chordChart || (l.chordChart?.computedAt ?? 0) > w.chordChart.computedAt
          ? l.chordChart ?? w.chordChart
          : w.chordChart,
    })).sort((a, b) => compare(a.identity.key, b.identity.key)),
  };
}
