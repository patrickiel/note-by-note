import type { FavoriteEntry, HistoryEntry } from '../../../core/model/types';
import {
  addFavorite,
  removeFavorite,
  setFavoritesOrder,
} from '../persist/favorites';
import { favoritesItem } from '../../../core/persist/storage';

class FavoritesStore {
  entries = $state<FavoriteEntry[]>([]);

  async init() {
    this.entries = await favoritesItem.getValue();
    favoritesItem.watch((value) => {
      this.entries = value ?? [];
    });
  }

  has(key: string): boolean {
    return this.entries.some((e) => e.identity.key === key);
  }

  async toggle(entry: HistoryEntry) {
    if (this.has(entry.identity.key)) await removeFavorite(entry.identity.key);
    else await addFavorite(entry);
  }

  async remove(key: string) {
    await removeFavorite(key);
  }

  /** Commit a new manual order (complete list of identity keys). Applied
   * optimistically so the list doesn't snap back while storage round-trips. */
  async reorder(keys: string[]) {
    const byKey = new Map(this.entries.map((e) => [e.identity.key, e]));
    const next = keys
      .map((k) => byKey.get(k))
      .filter((e): e is (typeof this.entries)[number] => e !== undefined);
    if (next.length === this.entries.length) this.entries = next;
    await setFavoritesOrder(keys);
  }
}

export const favorites = new FavoritesStore();
