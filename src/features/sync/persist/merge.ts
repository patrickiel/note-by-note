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
} from '../../../core/persist/deletions.ts';
import { hasChart } from './fit.ts';
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
 *     winner without a chart adopts the other's: absent may mean "trimmed",
 *     and a chart is only ever replaced by re-analysis.
 *   - Settings and UI prefs: the newer device's, as a whole. EQ presets: union
 *     by name, the later save of a shared name, deletions honoured.
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

export function mergeBackups(
  local: Backup,
  remote: Backup,
  remoteWins: boolean,
  now = Date.now(),
): Backup {
  const [winner, loser] = remoteWins ? [remote, local] : [local, remote];
  const deletions = pruneDeletions(mergeDeletions(local.deletions ?? {}, remote.deletions ?? {}), now);
  const history = unionNewest(winner.history, loser.history, song, (e) =>
    deletedSince(deletions, at(e), historyDeletion(song(e)), HISTORY_CLEARED),
  );
  return {
    ...local,
    exportedAt: Math.max(local.exportedAt ?? 0, remote.exportedAt ?? 0),
    settings: winner.settings,
    uiPrefs: winner.uiPrefs,
    eqPresets: unionNewest(
      winner.eqPresets,
      loser.eqPresets,
      (p) => p.name,
      (p) => deletedSince(deletions, at(p), presetDeletion(p.name)),
    ),
    history: history.sort((a, b) => at(b) - at(a)).slice(0, HISTORY_LIMIT),
    favorites: unionNewest(
      winner.favorites,
      loser.favorites,
      song,
      (f) => deletedSince(deletions, Math.max(f.favoritedAt ?? 0, at(f)), favoriteDeletion(song(f))),
      (w, l): FavoriteEntry => ({
        ...w,
        lastAccessedAt: Math.max(w.lastAccessedAt ?? 0, l.lastAccessedAt ?? 0),
      }),
    ),
    tracks: unionNewest(
      winner.tracks,
      loser.tracks,
      (t) => t.identity.key,
      undefined,
      (w, l) => (!hasChart(w) && hasChart(l) ? { ...w, chordChart: l.chordChart } : w),
    ),
    deletions,
  };
}
