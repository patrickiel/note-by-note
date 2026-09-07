import { HISTORY_LIMIT } from '../../../core/model/defaults';
import type { HistoryEntry, EffectParams, TrackIdentity } from '../../../core/model/types';
import { isSameTrack } from '../../../core/model/track-identity';
import { isLive, tombstone } from '../../../core/persist/deletions';
import { historyItem } from '../../../core/persist/storage';

/** Newest first, with the live rows capped at `HISTORY_LIMIT`. Tombstones
 * (`deletions.ts`) are kept whatever the count — they are pruned by age, cost
 * a few bytes each, and dropping one on a full list would let another device's
 * older copy bring the row back. */
function capped(list: HistoryEntry[]): HistoryEntry[] {
  let live = 0;
  return list.filter((entry) => !isLive(entry) || ++live <= HISTORY_LIMIT);
}

/** Insert or refresh a Recent entry (newest first, LRU-capped).
 *
 * `onlyExisting` refreshes a row that is already there but never adds one —
 * what Auto Save off means, since that toggle is about *adding* every song you
 * play. Keeping the row current either way is what stops the Recent copy from
 * drifting away from the Favorites copy of the same song. */
export async function upsertHistory(
  identity: TrackIdentity,
  params: EffectParams,
  pageUrl: string,
  thumbnailUrl?: string,
  onlyExisting = false,
): Promise<void> {
  const list = await historyItem.getValue();
  const now = Date.now();
  const existing = list.find((e) => isLive(e) && isSameTrack(e.identity, identity));
  if (!existing && onlyExisting) return;
  const entry = {
    identity,
    params,
    pageUrl,
    thumbnailUrl: thumbnailUrl ?? existing?.thumbnailUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // This row supersedes any older one for the same song — a tombstone for it
  // included, this play being the newer statement about it.
  const next = [entry, ...list.filter((e) => !isSameTrack(e.identity, identity))];
  await historyItem.setValue(capped(next));
}

/** The user removed a row: it stays as a tombstone (`deletions.ts`) so a sync
 * merge with another device's older copy doesn't bring it back, and moves to
 * the front to keep the list newest-first. `record: false` is for housekeeping
 * that drops a stale twin of a song that stays — a tombstone there would name
 * the song, and kill its fresh row on the other devices. */
export async function removeHistoryEntry(
  key: string,
  { record = true }: { record?: boolean } = {},
): Promise<void> {
  const list = await historyItem.getValue();
  const entry = list.find((e) => e.identity.key === key);
  const rest = list.filter((e) => e.identity.key !== key);
  await historyItem.setValue(
    record && entry ? [tombstone(entry, Date.now()), ...rest] : rest,
  );
}

export async function clearHistory(): Promise<void> {
  const list = await historyItem.getValue();
  const now = Date.now();
  await historyItem.setValue(list.map((e) => (isLive(e) ? tombstone(e, now) : e)));
}
