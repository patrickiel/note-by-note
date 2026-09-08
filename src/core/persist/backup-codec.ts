import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import { songKey } from '../model/track-identity.ts';
import type { Library, SharedLibrary } from './library.ts';
import { parseBackupJson as parseLegacy } from './legacy-backup.ts';
import { migrateBackup } from './library-migration.ts';

export const BACKUP_FORMAT = 'note-by-note-backup';
export const BACKUP_VERSION = 2;
export interface Backup extends Library { format: typeof BACKUP_FORMAT; version: typeof BACKUP_VERSION; exportedAt: number }

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
/** Missing preference groups use defaults, just like missing individual fields. */
export function defaults<T>(value: unknown, fallback: T, recover = false): T {
  let source: Record<string, any>;
  try { source = object(value ?? {}); } catch (error) {
    if (!recover) throw error;
    return structuredClone(fallback);
  }
  const result = structuredClone(fallback) as Record<string, any>;
  for (const [key, expected] of Object.entries(result)) {
    if (!(key in source)) continue;
    try {
      const next = source[key];
      if (expected === null) { if (next !== null) number(next); }
      else if (Array.isArray(expected)) array(next).forEach(number);
      else if (typeof expected === 'object') { result[key] = defaults(next, expected, recover); continue; }
      else if (typeof next !== typeof expected) throw new Error('Damaged library setting.');
      else if (typeof next === 'number') number(next);
      result[key] = next;
    } catch (error) { if (!recover) throw error; }
  }
  return result as T;
}
export function parseShared(value: unknown): SharedLibrary {
  const shared = structuredClone(object(value));
  number(shared.updatedAt);
  if (shared.updatedAt < 0) throw new Error('Damaged library revision.');
  shared.settings = defaults(shared.settings, DEFAULT_SETTINGS);
  array(shared.favoriteOrder).forEach(string);
  for (const [key, raw] of Object.entries(object(shared.songs))) {
    const song = object(raw);
    if (song.favoritedAt !== null) number(song.favoritedAt);
    const practice = song.practice;
    if (!/^(yt|file|web):/.test(key)) throw new Error('Damaged song key.');
    object(practice);
    number(practice.updatedAt);
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
  for (const preset of Object.values(object(shared.presets))) array(preset).forEach(number);
  return { updatedAt: shared.updatedAt, settings: shared.settings, songs: shared.songs,
    presets: shared.presets, favoriteOrder: shared.favoriteOrder };
}
export function parseLibrary(value: unknown): Library {
  const source = object(value);
  const local = object(source.local ?? {});
  const charts = object(local.charts ?? {});
  for (const chart of Object.values(charts)) {
    if (chart === null) continue;
    object(chart); number(chart.computedAt); number(chart.coverage); number(chart.analyzedFrom); number(chart.analyzedTo);
    array(chart.segments).forEach((s) => { object(s); number(s.startT); number(s.endT); string(s.label); number(s.confidence); });
    if (chart.key !== null) { object(chart.key); string(chart.key.tonic); string(chart.key.mode); number(chart.key.confidence); }
  }
  const lastAccessed = object(local.lastAccessed ?? {});
  const recent = object(local.recent ?? {});
  Object.values(recent).forEach(number);
  Object.values(lastAccessed).forEach(number);
  if (local.importRevision !== undefined) {
    number(local.importRevision);
    if (!Number.isSafeInteger(local.importRevision) || local.importRevision < 0) throw new Error('Damaged import revision.');
  }
  return {
    shared: parseShared(source.shared),
    local: { uiPrefs: defaults(local.uiPrefs, DEFAULT_UI_PREFS), recent, lastAccessed, charts,
      ...(local.lastUsedParams ? { lastUsedParams: defaults(local.lastUsedParams, DEFAULT_PARAMS) } : {}),
      ...(local.importRevision !== undefined ? { importRevision: local.importRevision } : {}) },
  };
}
export function parseBackupJson(value: unknown): Backup {
  const raw = object(value);
  if (raw.format !== BACKUP_FORMAT) throw new Error("That file isn't a Note by Note backup.");
  if (raw.version > BACKUP_VERSION) throw new Error('That backup was made by a newer version of Note by Note.');
  const library = parseLibrary(raw.version === BACKUP_VERSION ? raw : migrateBackup(parseLegacy(raw)));
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: raw.exportedAt ?? 0, ...library };
}
