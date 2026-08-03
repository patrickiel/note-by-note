import type { FavoriteEntry, HistoryEntry, TrackIdentity } from '../../../core/model/types';
import {
  addFavorite,
  removeFavorite,
  setFavoritesOrder,
} from '../persist/favorites';
import { isSameTrack } from '../../../core/model/track-identity';
import { favoritesItem } from '../../../core/persist/storage';

/** Every write below is fired from a click handler as a floating promise, and
 * the store only repaints from the `favoritesItem.watch` callback — so a failed
 * write repaints nothing and reads as a dead button. Log instead of vanishing. */
async function write(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`[note-by-note] favorites: ${what} failed:`, err);
  }
}

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
    // $state.snapshot: `entry` belongs to the history store, so it and its
    // nested identity/params are proxies. Firefox structured-clones storage
    // writes and throws DataCloneError on a proxy (Chrome, which serializes to
    // JSON, does not) — without this the star silently never lights.
    await write('toggle', () =>
      existing
        ? removeFavorite(existing.identity.key)
        : addFavorite($state.snapshot(entry) as HistoryEntry),
    );
  }

  async remove(key: string) {
    await write('remove', () => removeFavorite(key));
  }

  /** Commit a new manual order (complete list of identity keys). Applied
   * optimistically so the list doesn't snap back while storage round-trips. */
  async reorder(keys: string[]) {
    const byKey = new Map(this.entries.map((e) => [e.identity.key, e]));
    const next = keys
      .map((k) => byKey.get(k))
      .filter((e): e is (typeof this.entries)[number] => e !== undefined);
    if (next.length === this.entries.length) this.entries = next;
    await write('reorder', () => setFavoritesOrder(keys));
  }
}

export const favorites = new FavoritesStore();
