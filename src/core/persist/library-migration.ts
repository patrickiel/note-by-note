import { DEFAULT_PARAMS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';
import { defineEntry, emptyLibrary, type Library, type Practice, type SavedSong } from './library.ts';
import type { Backup } from './legacy-backup.ts';

/** Collapse old Recent/Favorites/track copies once, at the boundary. */
export function migrateBackup(backup: Backup): Library {
  const library = emptyLibrary();
  const { shared, local } = library;
  const { lastUsedParams, ...settings } = backup.settings;
  shared.settings = { ...shared.settings, ...settings };
  local.lastUsedParams = lastUsedParams;
  local.uiPrefs = { ...local.uiPrefs, ...backup.uiPrefs };
  const ensure = (identity: Practice['identity']): SavedSong => {
    const normalized = makeTrackIdentity(identity.normalizedUrl, identity.title, identity.durationSec);
    return shared.songs[normalized.key] ??= {
      practice: { identity: normalized, pageUrl: normalized.normalizedUrl, updatedAt: 0,
        markers: [], snippets: [], sequenceLoop: false, sequenceCountIn: false },
      favoritedAt: null,
    };
  };
  const observe = (at = 0) => { shared.updatedAt = Math.max(shared.updatedAt, at); };
  // History dates saved parameters; a favorite's star date must not outrank an edit.
  const entries = [...backup.favorites, ...backup.history]
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  for (const entry of entries) {
    const song = ensure(entry.identity);
    song.practice = { ...song.practice, params: { ...DEFAULT_PARAMS, ...entry.params },
      pageUrl: entry.pageUrl, thumbnailUrl: entry.thumbnailUrl, updatedAt: entry.updatedAt ?? 0 };
    observe(entry.updatedAt);
  }
  for (const track of [...backup.tracks].sort((a, b) => a.updatedAt - b.updatedAt)) {
    const song = ensure(track.identity);
    const { identity, updatedAt, chordChart, ...data } = track;
    song.practice = { ...song.practice, ...data, updatedAt: Math.max(updatedAt, song.practice.updatedAt) };
    local.charts[song.practice.identity.key] = chordChart ?? null;
    observe(updatedAt);
  }
  for (const entry of backup.history) {
    const key = ensure(entry.identity).practice.identity.key;
    local.recent[key] = entry.updatedAt;
    local.lastAccessed[key] = entry.updatedAt;
  }
  for (const entry of backup.favorites) {
    const song = ensure(entry.identity);
    song.favoritedAt = entry.favoritedAt;
    const key = song.practice.identity.key;
    local.lastAccessed[key] = Math.max(local.lastAccessed[key] ?? 0, entry.lastAccessedAt);
    observe(entry.favoritedAt);
  }
  shared.favoriteOrder = backup.favorites.map((f) => ensure(f.identity).practice.identity.key);
  for (const preset of backup.eqPresets) defineEntry(shared.presets, preset.name, preset.gains);
  return library;
}
