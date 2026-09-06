import type { TrackData } from '../model/types';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  parseBackupJson,
  type Backup,
} from './backup-codec';
import { mergeDeletions, pruneDeletions, reviveBackup } from './deletions';
import {
  deletionsItem,
  eqPresetsItem,
  favoritesItem,
  historyItem,
  removeTrackDataExcept,
  saveTrackData,
  settingsItem,
  uiPrefsItem,
} from './storage';

/** The file shape and its compact codec live in `backup-codec.ts` (pure, so
 * they run under `node --test`); this module is the storage side. */
export type { Backup };

/** Raw storage keys have no `local:` prefix — see `trackDataKey`. */
async function loadAllTrackData(): Promise<TrackData[]> {
  const snapshot = await browser.storage.local.get(null);
  return Object.entries(snapshot)
    .filter(([key]) => key.startsWith('track:'))
    .map(([, value]) => value as TrackData);
}

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

/**
 * Reads a backup file's text into a `Backup`, or throws an `Error` whose
 * message is safe to show the user. Accepts the compact format the export
 * writes and the verbose one older builds wrote; either way objects are
 * backfilled from the defaults so a file from an older build gains any setting
 * added since.
 */
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return parseBackupJson(raw);
}

/**
 * Replaces every stored value with the backup's, dropping data the file does
 * not carry — a restore reproduces the machine it came from rather than
 * merging into whatever is here. Host permissions are left untouched.
 * Deletion records are the one thing merged, not replaced: forgetting this
 * device's would let a sync merge resurrect what it had removed. Manual file
 * imports use `asNew` to re-add their contents; sync restores keep their dates.
 *
 * Track records are written first and the leftovers removed afterwards, never
 * the other way round. A sync merge calls this on every remote change, and
 * the panel document can go away mid-restore (the user closes it, the tab
 * changes) — wiping first would make that window cost every marker, snippet
 * and chart in the library. This way the worst case is a stale record the
 * next restore removes.
 */
export async function restoreBackup(backup: Backup, { asNew = false } = {}): Promise<void> {
  const deletions = pruneDeletions(
    mergeDeletions(await deletionsItem.getValue(), backup.deletions ?? {}), Date.now(),
  );
  if (asNew) backup = reviveBackup(backup, deletions);
  await Promise.all([
    settingsItem.setValue(backup.settings),
    uiPrefsItem.setValue(backup.uiPrefs),
    historyItem.setValue(backup.history),
    favoritesItem.setValue(backup.favorites),
    eqPresetsItem.setValue(backup.eqPresets),
    deletionsItem.setValue(deletions),
    ...backup.tracks.map(saveTrackData),
  ]);
  await removeTrackDataExcept(new Set(backup.tracks.map((t) => t.identity.key)));
}
