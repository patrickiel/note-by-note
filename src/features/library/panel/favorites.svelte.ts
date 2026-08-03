import type { FavoriteEntry, HistoryEntry, TrackIdentity } from '../../../core/model/types';
import {
  addFavorite,
  removeFavorite,
  setFavoritesOrder,
} from '../persist/favorites';
import { isSameTrack } from '../../../core/model/track-identity';
import { favoritesItem } from '../../../core/persist/storage';

class FavoritesStore {
  entries = $state<FavoriteEntry[]>([]);

  async init() {
    this.entries = await favoritesItem.getValue();
    favoritesItem.watch((value) => {
      this.entries = value ?? [];
    });
  }

  /** By song, not by key: a favorite stored under a duration that has since
   * drifted is still this track, and its star has to read as lit. */
  has(identity: TrackIdentity): boolean {
    return this.entries.some((e) => isSameTrack(e.identity, identity));
  }

  async toggle(entry: HistoryEntry) {
    // Unstar the row as it was stored — its key may differ from this one's.
    const existing = this.entries.find((e) => isSameTrack(e.identity, entry.identity));
    if (existing) await removeFavorite(existing.identity.key);
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
