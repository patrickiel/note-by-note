// Read-only adapter for the version-1 backup format, the only one any released
// build ever wrote. New writes use the library schema (backup-codec.ts).
import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';

import { rekeyByIdentity } from './rekey.ts';

import type {
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  Settings,
  TrackData,
  UiPrefs,
} from '../model/types';

const BACKUP_FORMAT = 'note-by-note-backup';

const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  settings: Settings;
  uiPrefs: UiPrefs;
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  eqPresets: EqPreset[];
  /** Per-track markers and snippets, one entry per saved track. */
  tracks: TrackData[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function damaged(section: string): Error {
  return new Error(`This backup's "${section}" list is damaged.`);
}

function arr(value: unknown, section: string): unknown[] {
  if (!Array.isArray(value)) throw damaged(section);
  return value;
}

function identifiedArr<T>(value: unknown, section: string): T[] {
  const list = arr(value, section);
  const identified = list.every(
    (e) => isRecord(e) && isRecord(e.identity) && typeof e.identity.normalizedUrl === 'string',
  );
  if (!identified) throw damaged(section);
  return list as T[];
}

function normalizeV1(raw: Record<string, unknown>): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(isRecord(raw.settings) ? raw.settings : {}),
    } as Settings,
    uiPrefs: {
      ...(JSON.parse(JSON.stringify(DEFAULT_UI_PREFS)) as UiPrefs),
      ...(isRecord(raw.uiPrefs) ? raw.uiPrefs : {}),
    },
    history: rekeyByIdentity(identifiedArr<HistoryEntry>(raw.history, 'history')),
    favorites: rekeyByIdentity(identifiedArr<FavoriteEntry>(raw.favorites, 'favorites')),
    eqPresets: arr(raw.eqPresets, 'eqPresets') as EqPreset[],
    tracks: rekeyByIdentity(identifiedArr<TrackData>(raw.tracks, 'tracks')),
  };
}

export function parseBackupJson(raw: unknown): Backup {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a Note by Note backup.");
  }
  if (raw.version === BACKUP_VERSION) return normalizeV1(raw);
  throw new Error('That backup is in a format this version of Note by Note no longer reads.');
}
