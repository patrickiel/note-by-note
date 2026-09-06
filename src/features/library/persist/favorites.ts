import type { EffectParams, HistoryEntry, TrackIdentity } from '../../../core/model/types';
import { isSameTrack } from '../../../core/model/track-identity';
import { favoriteDeletion } from '../../../core/persist/deletions';
import { favoritesItem, recordDeletion } from '../../../core/persist/storage';

/** Star a song: copy the history entry into the Favorites library (top of the
 * manual order). No-op if already favorited. */
export async function addFavorite(entry: HistoryEntry): Promise<void> {
  const list = await favoritesItem.getValue();
  // By song, not by key — starring the same track after its duration settled
  // differently must not add a second row.
  if (list.some((e) => isSameTrack(e.identity, entry.identity))) return;
  const now = Date.now();
  await favoritesItem.setValue([
    { ...entry, favoritedAt: now, lastAccessedAt: now },
    ...list,
  ]);
}

/** Dated (`deletions.ts`) so a sync merge with another device's older copy
 * doesn't star the song again. */
export async function removeFavorite(key: string): Promise<void> {
  const list = await favoritesItem.getValue();
  await favoritesItem.setValue(list.filter((e) => e.identity.key !== key));
  await recordDeletion(favoriteDeletion(key));
}

/** Persist a new manual order (list of identity keys, complete). */
export async function setFavoritesOrder(keys: string[]): Promise<void> {
  const list = await favoritesItem.getValue();
  const byKey = new Map(list.map((e) => [e.identity.key, e]));
  const next = keys.map((k) => byKey.get(k)).filter((e) => e !== undefined);
  // Keep entries missing from `keys` (e.g. added concurrently) at the top.
  const missing = list.filter((e) => !keys.includes(e.identity.key));
  await favoritesItem.setValue([...missing, ...next]);
}

/** Refresh a favorite when its track is opened/played: bump Last Accessed and
 * mirror the latest settings. No-op if the track isn't favorited.
 *
 * Matched by song, like every other favorites operation. Matching on
 * `identity.key` would stop finding the row as soon as the duration drifted
 * (pre-roll ad, late metadata) — the favorite would then freeze while Recent,
 * which matches by song, kept updating, and the two copies would disagree. */
export async function touchFavorite(
  identity: TrackIdentity,
  patch?: { params?: EffectParams; pageUrl?: string; thumbnailUrl?: string },
): Promise<void> {
  const list = await favoritesItem.getValue();
  const index = list.findIndex((e) => isSameTrack(e.identity, identity));
  if (index === -1) return;
  const now = Date.now();
  const entry = list[index];
  const next = [...list];
  next[index] = {
    ...entry,
    // Adopt the current identity so the row stops being pinned to whatever
    // duration it happened to be saved under.
    identity,
    params: patch?.params ?? entry.params,
    pageUrl: patch?.pageUrl ?? entry.pageUrl,
    thumbnailUrl: patch?.thumbnailUrl ?? entry.thumbnailUrl,
    lastAccessedAt: now,
    updatedAt: patch?.params ? now : entry.updatedAt,
  };
  await favoritesItem.setValue(next);
}
