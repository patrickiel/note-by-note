import { BACKUP_FORMAT, BACKUP_VERSION, normalizeBackup, type Backup } from './backup-format';
import {
  historyDeletion,
  mergeDeletions,
  pruneDeletions,
  trackDeletion,
  type Deletions,
} from './deletions';
import {
  deletionsItem,
  eqPresetsItem,
  favoritesItem,
  historyItem,
  loadAllTrackData,
  removeAllTrackData,
  saveTrackData,
  settingsItem,
  uiPrefsItem,
} from './storage';

export type { Backup } from './backup-format';

export async function createBackup(): Promise<Backup> {
  const [settings, uiPrefs, history, favorites, eqPresets, tracks, deletions] =
    await Promise.all([
      settingsItem.getValue(),
      uiPrefsItem.getValue(),
      historyItem.getValue(),
      favoritesItem.getValue(),
      eqPresetsItem.getValue(),
      loadAllTrackData(),
      deletionsItem.getValue(),
    ]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    appVersion: browser.runtime.getManifest().version,
    settings,
    uiPrefs,
    history,
    favorites,
    eqPresets,
    tracks,
    deletions,
  };
}

/** Suggested download name, e.g. `note-by-note-backup-2026-07-17.json`. */
export function backupFilename(exportedAt: number): string {
  const day = new Date(exportedAt).toISOString().slice(0, 10);
  return `note-by-note-backup-${day}.json`;
}

/** Reads a backup file's text into a `Backup`, or throws an `Error` whose
 * message is safe to show the user (see `normalizeBackup`). */
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return normalizeBackup(raw);
}

/**
 * Replaces every stored value with the backup's, dropping data the file does
 * not carry — a restore reproduces the machine it came from rather than
 * merging into whatever is here. Host permissions are left untouched.
 *
 * What the restore drops is dated as deleted (see `deletions.ts`), so sync
 * removes it on other devices too instead of keeping their copies and
 * bringing them back here. The file's own records come along; this device's
 * old ones do not — the file may carry items they would contradict.
 */
export async function restoreBackup(backup: Backup): Promise<void> {
  const [tracks, history] = await Promise.all([loadAllTrackData(), historyItem.getValue()]);
  const now = Date.now();
  const kept = new Set([...backup.tracks, ...backup.history].map((e) => e.identity.key));
  const dropped: Deletions = {};
  for (const t of tracks) if (!kept.has(t.identity.key)) dropped[trackDeletion(t.identity.key)] = now;
  for (const h of history) if (!kept.has(h.identity.key)) dropped[historyDeletion(h.identity.key)] = now;
  await removeAllTrackData();
  await Promise.all([
    settingsItem.setValue(backup.settings),
    uiPrefsItem.setValue(backup.uiPrefs),
    historyItem.setValue(backup.history),
    favoritesItem.setValue(backup.favorites),
    eqPresetsItem.setValue(backup.eqPresets),
    deletionsItem.setValue(pruneDeletions(mergeDeletions(backup.deletions, dropped), now)),
    ...backup.tracks.map(saveTrackData),
  ]);
}
