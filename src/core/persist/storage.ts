import { storage, type StorageItemKey, type WxtStorageItem } from '#imports';
import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults';
import { hasContent } from '../model/track-content';
import type {
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  Settings,
  TrackData,
  UiPrefs,
} from '../model/types';

/** Rebuild a value as plain arrays/objects, stripping any Svelte `$state`
 * proxies on the way.
 *
 * Chrome serializes storage writes to JSON and reads straight through a proxy;
 * Firefox structured-clones them and throws DataCloneError, rejecting the write
 * with nothing persisted. Panel stores are expected to `$state.snapshot` before
 * writing, but one missed call is an invisible, browser-specific data-loss bug —
 * so every write goes through here as well.
 *
 * A rebuild, not `structuredClone`: that throws on a proxy, which is the very
 * case being defended against. Safe because this schema is JSON-shaped
 * throughout (numbers, strings, booleans, arrays, plain objects); a Date, Map or
 * typed array added later would need handling here first.
 *
 * Plain function, not the `$state.snapshot` rune: background.ts imports this
 * module and runes only compile inside Svelte files. */
function toPlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(toPlain) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = toPlain(v);
  return out as T;
}

/** `storage.defineItem` with proxy-stripping on every write. Annotated rather
 * than inferred: `storage.defineItem` is overloaded five ways, so deriving this
 * signature from it makes the inference circular. */
function defineItem<T>(
  key: StorageItemKey,
  options: { fallback: T },
): WxtStorageItem<T, Record<string, unknown>> {
  const item = storage.defineItem<T>(key, options);
  const setValue = item.setValue.bind(item);
  item.setValue = (value: T) => setValue(toPlain(value));
  return item;
}

export const settingsItem = defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export const uiPrefsItem = defineItem<UiPrefs>('local:uiPrefs', {
  fallback: DEFAULT_UI_PREFS,
});

/** Recent history (Auto Save), newest first. */
export const historyItem = defineItem<HistoryEntry[]>('local:history', {
  fallback: [],
});

/** Starred songs (History → Favorites). Array order = manual sort order. */
export const favoritesItem = defineItem<FavoriteEntry[]>('local:favorites', {
  fallback: [],
});

/** EQ curves the user saved (Equalizer → preset row). Array order = save order.
 * Kept out of `settings` so Reset Settings can't wipe them. */
export const eqPresetsItem = defineItem<EqPreset[]>('local:eqPresets', {
  fallback: [],
});

/** Origins the user has granted host permission for (mirrors permissions API,
 * used to show/revoke the list without a permissions query round-trip). */
export const grantedOriginsItem = defineItem<string[]>('local:grantedOrigins', {
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
  await storage.setItem(trackDataKey(data.identity.key), toPlain(data));
}

export async function removeTrackData(key: string): Promise<void> {
  await storage.removeItem(trackDataKey(key));
}

/** Raw `browser.storage` keys carry no `local:` prefix — see `trackDataKey`. */
const RAW_TRACK_PREFIX = 'track:';

export async function loadAllTrackData(): Promise<TrackData[]> {
  const snapshot = await browser.storage.local.get(null);
  return Object.entries(snapshot)
    .filter(([key]) => key.startsWith(RAW_TRACK_PREFIX))
    .map(([, value]) => value as TrackData);
}

/** One write for many records (a sync apply), instead of one per track. */
export async function saveAllTrackData(list: TrackData[]): Promise<void> {
  if (!list.length) return;
  const items: Record<string, TrackData> = {};
  for (const data of list) items[`${RAW_TRACK_PREFIX}${data.identity.key}`] = toPlain(data);
  await browser.storage.local.set(items);
}

export async function removeAllTrackData(): Promise<void> {
  const snapshot = await browser.storage.local.get(null);
  const keys = Object.keys(snapshot).filter((k) => k.startsWith(RAW_TRACK_PREFIX));
  if (keys.length) await browser.storage.local.remove(keys);
}

/** Drops records with nothing in them but flags (no markers, no snippets, no
 * chart) — earlier builds wrote one whenever a track was merely opened, and
 * each would otherwise sit in storage forever. Returns how many. */
export async function pruneEmptyTrackData(): Promise<number> {
  const snapshot = await browser.storage.local.get(null);
  const keys = Object.entries(snapshot)
    .filter(
      ([key, value]) => key.startsWith(RAW_TRACK_PREFIX) && !hasContent(value as TrackData),
    )
    .map(([key]) => key);
  if (keys.length) await browser.storage.local.remove(keys);
  return keys.length;
}
