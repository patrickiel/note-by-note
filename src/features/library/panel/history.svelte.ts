import type { HistoryEntry } from '../../../core/model/types';
import { clearHistory, dedupeHistory, removeHistoryEntry } from '../persist/history';
import { historyItem } from '../../../core/persist/storage';

class HistoryStore {
  entries = $state<HistoryEntry[]>([]);

  async init() {
    // Rows saved before dedupe-on-write can already be duplicated; collapse
    // them once, on the way in, so the list the user sees is the stored one.
    await dedupeHistory();
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
