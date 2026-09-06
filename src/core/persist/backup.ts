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
 * To sync, a restore is an edit made here, now: every restored track record
 * and Recent row is stamped with the current time so it outranks a peer's
 * copy (and any peer deletion record) in the merge — otherwise restoring an
 * older file would be undone by the next sync. Recent keeps the file's order
 * through a millisecond stagger. What the restore drops is dated as deleted
 * (see `deletions.ts`), so peers remove it too instead of keeping their
 * copies and bringing them back here. This device's existing deletion
 * records stay as well (something deleted here and absent from the file must
 * not come back from a stale peer); the `now` stamp already outranks them
 * for anything the file does restore. The file's own records come along too.
 */
export async function restoreBackup(backup: Backup): Promise<void> {
  const [oldTracks, oldHistory, oldDeletions] = await Promise.all([
    loadAllTrackData(),
    historyItem.getValue(),
    deletionsItem.getValue(),
  ]);
  const now = Date.now();
  const tracks = backup.tracks.map((t) => ({ ...t, updatedAt: now }));
  const history = backup.history.map((h, i) => ({ ...h, updatedAt: now - i }));
  const keptTracks = new Set(tracks.map((t) => t.identity.key));
  const keptHistory = new Set(history.map((h) => h.identity.key));
  const dropped: Deletions = {};
  for (const t of oldTracks) {
    if (!keptTracks.has(t.identity.key)) dropped[trackDeletion(t.identity.key)] = now;
  }
  for (const h of oldHistory) {
    if (!keptHistory.has(h.identity.key)) dropped[historyDeletion(h.identity.key)] = now;
  }
  await removeAllTrackData();
  await Promise.all([
    settingsItem.setValue(backup.settings),
    uiPrefsItem.setValue(backup.uiPrefs),
    historyItem.setValue(history),
    favoritesItem.setValue(backup.favorites),
    eqPresetsItem.setValue(backup.eqPresets),
    deletionsItem.setValue(
      pruneDeletions(mergeDeletions(mergeDeletions(oldDeletions, backup.deletions), dropped), now),
    ),
    ...tracks.map(saveTrackData),
  ]);
}
