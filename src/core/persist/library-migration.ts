import { DEFAULT_PARAMS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';
import { cell, emptyLibrary, newest, type Library, type Practice, type SavedSong } from './library.ts';
import type { Backup } from './legacy-backup.ts';

/** Collapse old Recent/Favorites/track copies once, at the boundary. */
export function migrateBackup(backup: Backup): Library {
  const library = emptyLibrary();
  const { shared, local } = library;
  const { lastUsedParams, updatedAt, ...settings } = backup.settings;
  shared.settings = cell({ ...shared.settings.value, ...settings }, updatedAt ?? 0);
  local.lastUsedParams = lastUsedParams;
  local.uiPrefs = { ...local.uiPrefs, ...backup.uiPrefs };
  const ensure = (identity: Practice['identity']): SavedSong => {
    const normalized = makeTrackIdentity(identity.normalizedUrl, identity.title, identity.durationSec);
    return shared.songs[normalized.key] ??= {
      practice: cell({ identity: normalized, pageUrl: normalized.normalizedUrl, markers: [], snippets: [], sequenceLoop: false, sequenceCountIn: false }),
      favorite: cell(false),
    };
  };
  // History dates saved parameters; a favorite's star date must not outrank an edit.
  const entries = [...backup.favorites, ...backup.history].filter((entry) => !entry.deleted)
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  for (const entry of entries) {
    const song = ensure(entry.identity);
    song.practice = cell({ ...song.practice.value!, params: { ...DEFAULT_PARAMS, ...entry.params },
      pageUrl: entry.pageUrl, thumbnailUrl: entry.thumbnailUrl }, entry.updatedAt ?? 0);
  }
  const tracks = [...backup.tracks].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const track of tracks) {
    const song = ensure(track.identity);
    const { identity, updatedAt, chordChart, ...data } = track;
    song.practice = cell({ ...song.practice.value!, ...data }, Math.max(updatedAt, song.practice.at));
    local.charts[song.practice.value!.identity.key] = chordChart ?? null;
  }
  for (const entry of backup.history) {
    if (entry.deleted) continue;
    const key = ensure(entry.identity).practice.value!.identity.key;
    local.recent[key] = entry.updatedAt;
    local.lastAccessed[key] = entry.updatedAt;
  }
  for (const entry of backup.favorites) {
    const song = ensure(entry.identity);
    song.favorite = newest(song.favorite, cell(!entry.deleted, entry.deleted ? entry.updatedAt : entry.favoritedAt));
    const key = song.practice.value!.identity.key;
    local.lastAccessed[key] = Math.max(local.lastAccessed[key] ?? 0, entry.lastAccessedAt);
  }
  shared.favoriteOrder = cell(backup.favorites.filter((f) => !f.deleted)
    .map((f) => makeTrackIdentity(f.identity.normalizedUrl, f.identity.title, f.identity.durationSec).key),
    Math.max(0, ...backup.favorites.map((f) => f.orderedAt ?? f.favoritedAt ?? 0)));
  for (const preset of backup.eqPresets) Object.defineProperty(shared.presets, preset.name, {
    value: cell(preset.deleted ? null : preset.gains, preset.updatedAt ?? 0), enumerable: true, writable: true, configurable: true,
  });
  return library;
}
