import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import { BACKUP_FORMAT, type Backup } from './backup-codec.ts';

export function backupFixture(patch: Partial<Backup> = {}): Backup {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: 1_757_000_000_000,
    appVersion: '',
    settings: structuredClone(DEFAULT_SETTINGS),
    uiPrefs: structuredClone(DEFAULT_UI_PREFS),
    history: [],
    favorites: [],
    eqPresets: [],
    tracks: [],
    deletions: {},
    ...patch,
  };
}
