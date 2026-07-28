import { storage } from '#imports';
import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults';
import type {
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  Settings,
  TrackData,
  UiPrefs,
} from '../model/types';

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export const uiPrefsItem = storage.defineItem<UiPrefs>('local:uiPrefs', {
  fallback: DEFAULT_UI_PREFS,
});

/** Recent history (Auto Save), newest first. */
export const historyItem = storage.defineItem<HistoryEntry[]>('local:history', {
  fallback: [],
});

/** Starred songs (History → Favorites). Array order = manual sort order. */
export const favoritesItem = storage.defineItem<FavoriteEntry[]>('local:favorites', {
  fallback: [],
});

/** EQ curves the user saved (Equalizer → preset row). Array order = save order.
 * Kept out of `settings` so Reset Settings can't wipe them. */
export const eqPresetsItem = storage.defineItem<EqPreset[]>('local:eqPresets', {
  fallback: [],
});

/** Origins the user has granted host permission for (mirrors permissions API,
 * used to show/revoke the list without a permissions query round-trip). */
export const grantedOriginsItem = storage.defineItem<string[]>('local:grantedOrigins', {
  fallback: [],
});

/** Per-track markers/snippets, keyed by TrackIdentity.key. */
export function trackDataKey(key: string) {
  return `local:track:${key}` as const;
}

export async function loadTrackData(key: string): Promise<TrackData | null> {
  return (await storage.getItem<TrackData>(trackDataKey(key))) ?? null;
}

export async function saveTrackData(data: TrackData): Promise<void> {
  await storage.setItem(trackDataKey(data.identity.key), data);
}

export async function removeAllTrackData(): Promise<void> {
  const snapshot = await browser.storage.local.get(null);
  const keys = Object.keys(snapshot).filter((k) => k.startsWith('track:'));
  if (keys.length) await browser.storage.local.remove(keys);
}
