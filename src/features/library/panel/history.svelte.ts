import type { HistoryEntry } from '../../../core/model/types';
import { clearHistory, dedupeHistory, removeHistoryEntry } from '../persist/history';
import { isLive } from '../../../core/persist/deletions';
import { historyItem } from '../../../core/persist/storage';

class HistoryStore {
  /** Live rows only: the stored list also carries tombstones for what the
   * user removed, which exist purely so a sync merge can't resurrect it
   * (`deletions.ts`). Filtering here is what keeps them out of every screen. */
  entries = $state<HistoryEntry[]>([]);

  async init() {
    // Rows saved before dedupe-on-write can already be duplicated; collapse
    // them once, on the way in, so the list the user sees is the stored one.
    await dedupeHistory();
    this.entries = (await historyItem.getValue()).filter(isLive);
    historyItem.watch((value) => {
      this.entries = (value ?? []).filter(isLive);
    });
  }

  async remove(key: string) {
    await removeHistoryEntry(key);
  }

  async clear() {
    await clearHistory();
  }
}

export const history = new HistoryStore();
