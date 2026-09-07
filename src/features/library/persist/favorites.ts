import type { EffectParams, FavoriteEntry, HistoryEntry, TrackIdentity } from '../../../core/model/types';
import { isSameTrack } from '../../../core/model/track-identity';
import { isLive, tombstone } from '../../../core/persist/deletions';
import { favoritesItem } from '../../../core/persist/storage';

/** Star a song: copy the history entry into the Favorites library (top of the
 * manual order). No-op if already favorited.
 *
 * `updatedAt` is the star itself — the star and the unstar are its only
 * writers, so it is the date the merge can trust for "is this song favorited"
 * (`deletions.ts`, `merge.ts`). `orderedAt` says the manual order changed:
 * this row went to the top. */
export async function addFavorite(entry: HistoryEntry): Promise<void> {
  const list = await favoritesItem.getValue();
  // By song, not by key — starring the same track after its duration settled
  // differently must not add a second row.
  if (list.some((e) => isLive(e) && isSameTrack(e.identity, entry.identity))) return;
  const now = Date.now();
  // Any tombstone for the song goes: this star is the newer statement.
  const rest = list.filter((e) => !isSameTrack(e.identity, entry.identity));
  await favoritesItem.setValue([
    { ...entry, favoritedAt: now, lastAccessedAt: now, updatedAt: now, orderedAt: now },
    ...rest,
  ]);
}

/** The star comes off: the row stays as a tombstone (`deletions.ts`) so a sync
 * merge with another device's older copy doesn't star the song again. */
export async function removeFavorite(key: string): Promise<void> {
  const list = await favoritesItem.getValue();
  const entry = list.find((e) => e.identity.key === key);
  const rest = list.filter((e) => e.identity.key !== key);
  await favoritesItem.setValue(entry ? [tombstone(entry, Date.now()), ...rest] : rest);
}

/** Persist a new manual order (list of identity keys, complete).
 *
 * The rank goes *into* each row, as `orderedAt` counting down from now, so the
 * order is something the rows say rather than something the list's shape says.
 * That is what lets a merge reproduce it — it sorts on the same field — instead
 * of having to pick one device's array over the other's (`merge.ts`). */
export async function setFavoritesOrder(keys: string[]): Promise<void> {
  const list = await favoritesItem.getValue();
  const live = list.filter(isLive);
  const byKey = new Map(live.map((e) => [e.identity.key, e]));
  const next = keys.map((k) => byKey.get(k)).filter((e) => e !== undefined);
  // Keep entries missing from `keys` (e.g. added concurrently) at the top.
  const missing = live.filter((e) => !keys.includes(e.identity.key));
  const now = Date.now();
  await favoritesItem.setValue([
    ...[...missing, ...next].map((e, i) => ({ ...e, orderedAt: now - i })),
    ...list.filter((e) => !isLive(e)),
  ]);
}

/** Refresh a favorite when its track is opened/played: bump Last Accessed and
 * mirror the latest settings. No-op if the track isn't favorited.
 *
 * Matched by song, like every other favorites operation. Matching on
 * `identity.key` would stop finding the row as soon as the duration drifted
 * (pre-roll ad, late metadata) — the favorite would then freeze while Recent,
 * which matches by song, kept updating, and the two copies would disagree.
 *
 * Leaves `updatedAt` alone: the fields it writes are a cache of the Recent row
 * (the merge re-takes them from whichever copy is newer, `merge.ts`), and
 * dating the row for them would let a slider nudge here outrank an unfavorite
 * on another device. */
export async function touchFavorite(
  identity: TrackIdentity,
  patch?: { params?: EffectParams; pageUrl?: string; thumbnailUrl?: string },
): Promise<void> {
  const list = await favoritesItem.getValue();
  const index = list.findIndex((e) => isLive(e) && isSameTrack(e.identity, identity));
  if (index === -1) return;
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
    lastAccessedAt: Date.now(),
  } satisfies FavoriteEntry;
  await favoritesItem.setValue(next);
}
