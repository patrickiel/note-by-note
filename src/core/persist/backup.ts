import { BACKUP_FORMAT, BACKUP_VERSION, parseBackupJson, type Backup } from './backup-codec';
import { editLibrary, readLibrary } from './library-client';
export type { Backup };

export async function createBackup(): Promise<Backup> {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(), ...await readLibrary() };
}
export function backupFilename(at: number): string {
  return 'note-by-note-backup-' + new Date(at).toISOString().slice(0, 10) + '.json';
}
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON."); }
  return parseBackupJson(raw);
}
export function restoreBackup(backup: Backup): Promise<void> {
  return editLibrary({ type: 'import', library: backup });
}
