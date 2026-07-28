import type { HistoryEntry } from '../../../core/model/types';
import { clearHistory, removeHistoryEntry } from '../persist/history';
import { historyItem } from '../../../core/persist/storage';

class HistoryStore {
  entries = $state<HistoryEntry[]>([]);

  async init() {
    this.entries = await historyItem.getValue();
    historyItem.watch((value) => {
      this.entries = value ?? [];
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
