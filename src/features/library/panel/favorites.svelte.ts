import type { HistoryEntry, TrackIdentity } from '../../../core/model/types';
import { favoriteEntries } from '../../../core/persist/library';
import { editLibrary } from '../../../core/persist/library-client';
import { library } from '../../../core/state/library.svelte';

/** The list only repaints from the storage watch, so a rejected write leaves the
 * control looking dead. Log instead of vanishing. */
const write = (run: Promise<unknown>) =>
  run.catch((error: unknown) => console.error('[note-by-note] library write failed', error));

class FavoritesStore {
  /** Derived, not a getter: the rows are rebuilt only when the library changes,
   * not on every read while the Songs sheet renders. */
  entries = $derived(favoriteEntries(library.current));

  has(identity: TrackIdentity) { return library.current.shared.songs[identity.key]?.favoritedAt != null; }
  toggle(entry: HistoryEntry) {
    return write(editLibrary({ type: 'favorite', key: entry.identity.key,
      value: library.current.shared.songs[entry.identity.key]?.favoritedAt == null }));
  }
  remove(key: string) { return write(editLibrary({ type: 'favorite', key, value: false })); }
  reorder(keys: string[]) { return write(editLibrary({ type: 'order', keys })); }
}
export const favorites = new FavoritesStore();
