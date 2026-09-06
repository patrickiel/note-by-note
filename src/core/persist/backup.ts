import { BACKUP_FORMAT, BACKUP_VERSION, normalizeBackup, type Backup } from './backup-format';
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
 */
export async function restoreBackup(backup: Backup): Promise<void> {
  await removeAllTrackData();
  await Promise.all([
    settingsItem.setValue(backup.settings),
    uiPrefsItem.setValue(backup.uiPrefs),
    historyItem.setValue(backup.history),
    favoritesItem.setValue(backup.favorites),
    eqPresetsItem.setValue(backup.eqPresets),
    deletionsItem.setValue(backup.deletions),
    ...backup.tracks.map(saveTrackData),
  ]);
}
