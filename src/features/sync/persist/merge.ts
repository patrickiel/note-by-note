import { HISTORY_LIMIT } from '../../../core/model/defaults.ts';
import type { Backup } from '../../../core/persist/backup-codec.ts';
import {
  favoriteDeleted,
  historyDeleted,
  mergeDeletions,
  presetDeleted,
  pruneDeletions,
} from '../../../core/persist/deletions.ts';
import { songKey } from '../../../core/model/track-identity.ts';
import type {
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  TrackData,
  TrackIdentity,
} from '../../../core/model/types';

/**
 * Two devices' libraries into one. A union, item by item, so a copy another
 * device trimmed to fit the quota never deletes anything here, and edits made
 * on both sides since they last met both survive:
 *
 *   - Recent rows and favorites: matched by song (URL + title, like the
 *     library itself), the more recently updated one wins; a dated deletion
 *     (`deletions.ts`) beats any copy it postdates.
 *   - Track records: matched by key, the more recently edited wins outright —
 *     an emptied record is still a record, so clearing markers sticks. A
 *     winner without a chart adopts the other's: absent may mean "trimmed",
 *     and a chart is only ever replaced by re-analysis.
 *   - Settings and UI prefs: the newer device's, as a whole. EQ presets: union
 *     by name, the later save of a shared name, deletions honoured, the newer
 *     device's order first.
 *
 * `remoteWins` breaks ties and picks the wholesale sections: true when the
 * remote copy was written after this device's last local change. Pure;
 * `node --test`.
 */

const songId = (identity: TrackIdentity) => `${identity.normalizedUrl}\n${identity.title}`;

const byUpdatedDesc = (a: { updatedAt: number }, b: { updatedAt: number }) =>
  (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

function mergeHistory(
  first: HistoryEntry[],
  second: HistoryEntry[],
  deletions: Backup['deletions'],
): HistoryEntry[] {
  const bySong = new Map<string, HistoryEntry>();
  for (const entry of [...first, ...second]) {
    if (historyDeleted(deletions, songKey(entry.identity), entry.updatedAt ?? 0)) continue;
    const id = songId(entry.identity);
    const current = bySong.get(id);
    if (!current || (entry.updatedAt ?? 0) > (current.updatedAt ?? 0)) bySong.set(id, entry);
  }
  return [...bySong.values()].sort(byUpdatedDesc).slice(0, HISTORY_LIMIT);
}

function mergeFavorites(
  first: FavoriteEntry[],
  second: FavoriteEntry[],
  deletions: Backup['deletions'],
): FavoriteEntry[] {
  // Insertion order = the winner's manual order, then the other side's extras.
  const bySong = new Map<string, FavoriteEntry>();
  for (const entry of [...first, ...second]) {
    const since = Math.max(entry.favoritedAt ?? 0, entry.updatedAt ?? 0);
    if (favoriteDeleted(deletions, songKey(entry.identity), since)) continue;
    const id = songId(entry.identity);
    const current = bySong.get(id);
    if (!current) {
      bySong.set(id, entry);
    } else if ((entry.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
      bySong.set(id, {
        ...entry,
        lastAccessedAt: Math.max(entry.lastAccessedAt ?? 0, current.lastAccessedAt ?? 0),
      });
    } else if ((entry.lastAccessedAt ?? 0) > (current.lastAccessedAt ?? 0)) {
      bySong.set(id, { ...current, lastAccessedAt: entry.lastAccessedAt });
    }
  }
  return [...bySong.values()];
}

const hasChart = (track: TrackData) => !!track.chordChart && track.chordChart.segments.length > 0;

function mergeTracks(first: TrackData[], second: TrackData[]): TrackData[] {
  const byKey = new Map<string, TrackData>();
  for (const track of [...first, ...second]) {
    const current = byKey.get(track.identity.key);
    if (!current) {
      byKey.set(track.identity.key, track);
      continue;
    }
    const [winner, loser] =
      (track.updatedAt ?? 0) > (current.updatedAt ?? 0) ? [track, current] : [current, track];
    byKey.set(
      track.identity.key,
      !hasChart(winner) && hasChart(loser) ? { ...winner, chordChart: loser.chordChart } : winner,
    );
  }
  return [...byKey.values()];
}

/** Union by name; a dated deletion beats any copy it postdates, and a shared
 * name goes to the later save (the winner side on a tie, or when neither
 * carries a save time). */
function mergeEqPresets(
  first: EqPreset[],
  second: EqPreset[],
  deletions: Backup['deletions'],
): EqPreset[] {
  const byName = new Map<string, EqPreset>();
  for (const preset of [...first, ...second]) {
    if (presetDeleted(deletions, preset.name, preset.updatedAt ?? 0)) continue;
    const current = byName.get(preset.name);
    if (!current || (preset.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
      byName.set(preset.name, preset);
    }
  }
  return [...byName.values()];
}

export function mergeBackups(
  local: Backup,
  remote: Backup,
  remoteWins: boolean,
  now = Date.now(),
): Backup {
  const [winner, loser] = remoteWins ? [remote, local] : [local, remote];
  const deletions = pruneDeletions(mergeDeletions(local.deletions ?? {}, remote.deletions ?? {}), now);
  return {
    ...local,
    exportedAt: Math.max(local.exportedAt ?? 0, remote.exportedAt ?? 0),
    settings: winner.settings,
    uiPrefs: winner.uiPrefs,
    eqPresets: mergeEqPresets(winner.eqPresets, loser.eqPresets, deletions),
    history: mergeHistory(winner.history, loser.history, deletions),
    favorites: mergeFavorites(winner.favorites, loser.favorites, deletions),
    tracks: mergeTracks(winner.tracks, loser.tracks),
    deletions,
  };
}
