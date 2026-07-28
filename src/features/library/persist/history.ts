import { HISTORY_LIMIT } from '../../../core/model/defaults';
import type { EffectParams, TrackIdentity } from '../../../core/model/types';
import { historyItem } from '../../../core/persist/storage';

/** Insert or refresh a Recent entry (newest first, LRU-capped). */
export async function upsertHistory(
  identity: TrackIdentity,
  params: EffectParams,
  pageUrl: string,
  thumbnailUrl?: string,
): Promise<void> {
  const list = await historyItem.getValue();
  const now = Date.now();
  const existing = list.find((e) => e.identity.key === identity.key);
  const entry = {
    identity,
    params,
    pageUrl,
    thumbnailUrl: thumbnailUrl ?? existing?.thumbnailUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = [entry, ...list.filter((e) => e.identity.key !== identity.key)];
  await historyItem.setValue(next.slice(0, HISTORY_LIMIT));
}

export async function removeHistoryEntry(key: string): Promise<void> {
  const list = await historyItem.getValue();
  await historyItem.setValue(list.filter((e) => e.identity.key !== key));
}

export async function clearHistory(): Promise<void> {
  await historyItem.setValue([]);
}
