import { normalizeBackup } from '../../../core/persist/backup-format';
import { mergeDeletions, pruneDeletions } from '../../../core/persist/deletions';
import {
  deletionsItem,
  eqPresetsItem,
  favoritesItem,
  historyItem,
  loadAllTrackData,
  removeTrackDataByKeys,
  saveAllTrackData,
  settingsItem,
  uiPrefsItem,
} from '../../../core/persist/storage';
import { mergeHistory, mergeTracks } from './merge';
import { snapshotToBackup, type SyncSnapshot } from './sync-snapshot';

/**
 * Writes a remote snapshot over this device's data. Unlike `restoreBackup`,
 * this is a merge for what the sender may have trimmed to fit the quota
 * (`fit.ts`): an absent Recent row or per-track record is unknown to the
 * sender, not deleted, and stays here — unless the sender's deletion records
 * (`core/persist/deletions.ts`) date its removal. See `merge.ts` for the
 * rule; the deletion records themselves are merged too, so a third device
 * learns a deletion from whichever peer it syncs with.
 *
 * - settings, UI prefs, EQ presets and Favorites: taken wholesale (last
 *   write wins on the whole list — none of them is ever trimmed);
 * - Recent and tracks: merged.
 *
 * Known limit: there is no way to say "chart deleted" — clearing a chart on
 * one device leaves the other's copy until a new analysis overwrites it. The
 * alternative, sending an explicit null, would let a device that never
 * analysed a song wipe the chart on one that did, which is worse.
 */
export async function applySyncSnapshot(snapshot: SyncSnapshot): Promise<void> {
  // Backfills defaults an older sender lacked and validates the lists.
  const backup = normalizeBackup(snapshotToBackup(snapshot));
  const [localTracks, localHistory, localDeleted] = await Promise.all([
    loadAllTrackData(),
    historyItem.getValue(),
    deletionsItem.getValue(),
  ]);
  const tracks = mergeTracks(snapshot.tracks, localTracks, backup.deletions, localDeleted);
  const kept = new Set(tracks.map((t) => t.identity.key));
  await Promise.all([
    settingsItem.setValue(backup.settings),
    uiPrefsItem.setValue(backup.uiPrefs),
    historyItem.setValue(mergeHistory(backup.history, localHistory, backup.deletions, localDeleted)),
    favoritesItem.setValue(backup.favorites),
    eqPresetsItem.setValue(backup.eqPresets),
    deletionsItem.setValue(pruneDeletions(mergeDeletions(localDeleted, backup.deletions))),
    saveAllTrackData(tracks),
    removeTrackDataByKeys(localTracks.map((t) => t.identity.key).filter((k) => !kept.has(k))),
  ]);
}
