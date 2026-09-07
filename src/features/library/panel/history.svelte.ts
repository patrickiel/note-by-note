import type { HistoryEntry } from '../../../core/model/types';
import { clearHistory, removeHistoryEntry } from '../persist/history';
import { isLive } from '../../../core/persist/deletions';
import { historyItem } from '../../../core/persist/storage';

class HistoryStore {
  /** Live rows only: the stored list also carries tombstones for what the
   * user removed, which exist purely so a sync merge can't resurrect it
   * (`deletions.ts`). Filtering here is what keeps them out of every screen. */
  entries = $state<HistoryEntry[]>([]);

  async init() {
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
