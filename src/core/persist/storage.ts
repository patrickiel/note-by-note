import { storage, type StorageItemKey, type WxtStorageItem } from '#imports';
import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults';
import { pruneDeletions, type Deletions } from './deletions';
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

/** What the user deleted and when, so a sync merge doesn't bring it back —
 * see `deletions.ts`. Part of the backup; never part of "Reset Settings". */
export const deletionsItem = defineItem<Deletions>('local:deletions', {
  fallback: {},
});

/** Dates a deletion (`historyDeletion(key)`, `favoriteDeletion(key)`,
 * `HISTORY_CLEARED`) at now, pruning expired records on the way. */
export async function recordDeletion(...keys: string[]): Promise<void> {
  const now = Date.now();
  const current = await deletionsItem.getValue();
  const next = { ...current };
  for (const key of keys) next[key] = now;
  await deletionsItem.setValue(pruneDeletions(next, now));
}

/** Forgets a deletion — the item was re-created here, and a record dated
 * after its re-creation on another device would kill it in the merge. */
export async function clearDeletion(...keys: string[]): Promise<void> {
  const current = await deletionsItem.getValue();
  if (!keys.some((key) => key in current)) return;
  const next = { ...current };
  for (const key of keys) delete next[key];
  await deletionsItem.setValue(next);
}

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

export async function removeAllTrackData(): Promise<void> {
  const snapshot = await browser.storage.local.get(null);
  const keys = Object.keys(snapshot).filter((k) => k.startsWith('track:'));
  if (keys.length) await browser.storage.local.remove(keys);
}
