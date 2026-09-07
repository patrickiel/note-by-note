import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import { songKey } from '../model/track-identity.ts';
import { emptyLibrary, type Library, type SharedLibrary } from './library.ts';
import { parseBackupJson as parseLegacy } from './legacy-backup.ts';
import { migrateBackup } from './library-migration.ts';

export const BACKUP_FORMAT = 'note-by-note-backup';
export const BACKUP_VERSION = 4;
export interface Backup extends Library { format: typeof BACKUP_FORMAT; version: 4; exportedAt: number }

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Damaged library data.');
  return value as Record<string, any>;
}
function number(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Damaged library number.');
}
function string(value: unknown) {
  if (typeof value !== 'string') throw new Error('Damaged library text.');
}
function array(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error('Damaged library list.');
  return value;
}
function versioned(value: unknown) {
  const item = object(value);
  number(item.at);
  if (item.at < 0 || !('value' in item)) throw new Error('Damaged library revision.');
  return item;
}
/** Validate/backfill a JSON object against its version's defaults. */
function defaults<T>(value: unknown, fallback: T): T {
  const source = object(value);
  const result = structuredClone(fallback) as Record<string, any>;
  for (const [key, expected] of Object.entries(result)) {
    if (!(key in source)) continue;
    const next = source[key];
    if (expected === null) { if (next !== null) number(next); }
    else if (Array.isArray(expected)) array(next).forEach(number);
    else if (typeof expected === 'object') { result[key] = defaults(next, expected); continue; }
    else if (typeof next !== typeof expected) throw new Error('Damaged library setting.');
    if (typeof next === 'number') number(next);
    result[key] = next;
  }
  return result as T;
}
export function parseShared(value: unknown): SharedLibrary {
  const shared = structuredClone(object(value));
  shared.settings = versioned(shared.settings);
  shared.settings.value = defaults(shared.settings.value, DEFAULT_SETTINGS);
  shared.favoriteOrder = versioned(shared.favoriteOrder);
  array(shared.favoriteOrder.value).forEach(string);
  for (const [key, raw] of Object.entries(object(shared.songs))) {
    const song = object(raw);
    song.practice = versioned(song.practice);
    song.favorite = versioned(song.favorite);
    if (typeof song.favorite.value !== 'boolean') throw new Error('Damaged favorite.');
    const practice = song.practice.value;
    if (practice === null) continue;
    object(practice);
    const identity = object(practice.identity);
    string(identity.normalizedUrl); string(identity.title); number(identity.durationSec);
    if (key !== songKey(identity as any)) throw new Error('Song identity does not match its key.');
    identity.key = key;
    string(practice.pageUrl);
    if (practice.thumbnailUrl !== undefined) string(practice.thumbnailUrl);
    if (practice.params !== undefined) practice.params = defaults(practice.params, DEFAULT_PARAMS);
    array(practice.markers).forEach((m) => { object(m); string(m.id); string(m.label); number(m.t); });
    array(practice.snippets).forEach((s) => {
      object(s); string(s.id); string(s.name); number(s.startT); number(s.endT);
      if (s.repeats !== null && s.repeats !== Infinity) number(s.repeats);
      if (typeof s.enabled !== 'boolean') throw new Error('Damaged snippet.');
      for (const amount of Object.values(object(s.overrides))) number(amount);
    });
    if (typeof practice.sequenceLoop !== 'boolean' || typeof practice.sequenceCountIn !== 'boolean') throw new Error('Damaged sequence.');
    if (practice.chordsEnabled !== undefined && typeof practice.chordsEnabled !== 'boolean') throw new Error('Damaged chord setting.');
  }
  for (const raw of Object.values(object(shared.presets))) {
    const preset = versioned(raw);
    if (preset.value !== null) array(preset.value).forEach(number);
  }
  return { settings: shared.settings, songs: shared.songs, presets: shared.presets, favoriteOrder: shared.favoriteOrder };
}
export function parseLibrary(value: unknown): Library {
  const source = object(value);
  const local = object(source.local);
  const charts = object(local.charts);
  for (const chart of Object.values(charts)) {
    if (chart === null) continue;
    object(chart); number(chart.computedAt); number(chart.coverage); number(chart.analyzedFrom); number(chart.analyzedTo);
    array(chart.segments).forEach((s) => { object(s); number(s.startT); number(s.endT); string(s.label); number(s.confidence); });
    if (chart.key !== null) { object(chart.key); string(chart.key.tonic); string(chart.key.mode); number(chart.key.confidence); }
  }
  const recent = object(local.recent);
  for (const row of Object.values(recent)) { object(row); number(row.updatedAt); number(row.lastAccessedAt); }
  return {
    shared: parseShared(source.shared),
    local: { uiPrefs: defaults(local.uiPrefs, DEFAULT_UI_PREFS), recent, charts,
      ...(local.lastUsedParams ? { lastUsedParams: defaults(local.lastUsedParams, DEFAULT_PARAMS) } : {}) },
  };
}
export function parseBackupJson(value: unknown): Backup {
  const raw = object(value);
  if (raw.format !== BACKUP_FORMAT) throw new Error("That file isn't a Note by Note backup.");
  if (raw.version > BACKUP_VERSION) throw new Error('That backup was made by a newer version of Note by Note.');
  const library = raw.version === BACKUP_VERSION ? parseLibrary(raw) : migrateBackup(parseLegacy(raw));
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: raw.exportedAt ?? raw.at ?? 0, ...library };
}
