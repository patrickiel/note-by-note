import { HISTORY_LIMIT } from '../../../core/model/defaults';
import type { EffectParams, HistoryEntry, TrackIdentity } from '../../../core/model/types';
import { isSameTrack } from '../../../core/model/track-identity';
import { HISTORY_CLEARED, historyDeletion } from '../../../core/persist/deletions';
import { historyItem, recordDeletion } from '../../../core/persist/storage';

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
  const existing = list.find((e) => isSameTrack(e.identity, identity));
  if (!existing && onlyExisting) return;
  const entry = {
    identity,
    params,
    pageUrl,
    thumbnailUrl: thumbnailUrl ?? existing?.thumbnailUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // Matched by song, not by key: this row supersedes every older one for the
  // same song, so a duration that settled differently can't leave a twin behind.
  const next = [entry, ...list.filter((e) => !isSameTrack(e.identity, identity))];
  await historyItem.setValue(next.slice(0, HISTORY_LIMIT));
}

/** Collapse rows written before saves were matched by song (one song split
 * across several durations). The list is newest-first, so the first row for a
 * song wins and the older twins are dropped. */
export async function dedupeHistory(): Promise<void> {
  const list = await historyItem.getValue();
  const kept: HistoryEntry[] = [];
  for (const entry of list) {
    if (!kept.some((e) => isSameTrack(e.identity, entry.identity))) kept.push(entry);
  }
  if (kept.length !== list.length) await historyItem.setValue(kept);
}

/** Dated (see `deletions.ts`) so sync removes the row on other devices too
 * — a sync apply keeps rows the remote merely left out, so without the date
 * the row would come straight back. */
export async function removeHistoryEntry(key: string): Promise<void> {
  const list = await historyItem.getValue();
  const next = list.filter((e) => e.identity.key !== key);
  if (next.length === list.length) return;
  await historyItem.setValue(next);
  await recordDeletion(historyDeletion(key));
}

/** One record covers every row, however many there were. */
export async function clearHistory(): Promise<void> {
  await historyItem.setValue([]);
  await recordDeletion(HISTORY_CLEARED);
}
