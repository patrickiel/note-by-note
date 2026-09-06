import type { TrackData } from '../../../core/model/types';
import { normalizeBackup } from '../../../core/persist/backup-format';
import {
  eqPresetsItem,
  favoritesItem,
  historyItem,
  loadAllTrackData,
  saveAllTrackData,
  settingsItem,
  uiPrefsItem,
} from '../../../core/persist/storage';
import { decodeTrack, snapshotToBackup, type SyncSnapshot } from './sync-snapshot';

/**
 * Writes a remote snapshot over this device's data. Unlike `restoreBackup`,
 * this is a merge for the per-track records: the sender may have left some
 * out (or sent one without its chart) purely to fit the quota, and an absent
 * item must never read as a deletion here.
 *
 * - settings, UI prefs, EQ presets, Recent and Favorites: taken wholesale
 *   (last write wins on the whole list);
 * - tracks: every remote record is written; a remote record without a chart
 *   keeps this device's chart for that track; records only this device has
 *   are left untouched.
 *
 * Known limit: there is no way to say "chart deleted" — clearing a chart on
 * one device leaves the other's copy until a new analysis overwrites it. The
 * alternative, sending an explicit null, would let a device that never
 * analysed a song wipe the chart on one that did, which is worse.
 */
export async function applySyncSnapshot(snapshot: SyncSnapshot): Promise<void> {
  // Backfills defaults an older sender lacked and validates the lists.
  const backup = normalizeBackup(snapshotToBackup(snapshot));
  const local = new Map<string, TrackData>();
  for (const t of await loadAllTrackData()) local.set(t.identity.key, t);
  const merged = snapshot.tracks.map((remote): TrackData => {
    const decoded = decodeTrack(remote);
    const mine = local.get(remote.identity.key);
    const out: TrackData = {
      ...decoded,
      chordChart: remote.chart ? decoded.chordChart : (mine?.chordChart ?? null),
    };
    const chordsEnabled = remote.chordsEnabled ?? mine?.chordsEnabled;
    if (chordsEnabled !== undefined) out.chordsEnabled = chordsEnabled;
    return out;
  });
  await Promise.all([
    settingsItem.setValue(backup.settings),
    uiPrefsItem.setValue(backup.uiPrefs),
    historyItem.setValue(backup.history),
    favoritesItem.setValue(backup.favorites),
    eqPresetsItem.setValue(backup.eqPresets),
    saveAllTrackData(merged),
  ]);
}
