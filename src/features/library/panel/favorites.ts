import type { HistoryEntry, TrackIdentity } from '../../../core/model/types';
import { favoriteEntries } from '../../../core/persist/library';
import { editLibrary } from '../../../core/persist/library-client';
import { library } from '../../../core/state/library.svelte';

/** The list only repaints from the storage watch, so a rejected write leaves the
 * control looking dead. Log instead of vanishing. */
const write = (run: Promise<unknown>) =>
  run.catch((error: unknown) => console.error('[note-by-note] library write failed', error));

export const favorites = {
  get entries() { return favoriteEntries(library.current); },
  has: (identity: TrackIdentity) => library.current.shared.songs[identity.key]?.favoritedAt != null,
  toggle: (entry: HistoryEntry) => write(editLibrary({ type: 'favorite', key: entry.identity.key,
    value: library.current.shared.songs[entry.identity.key]?.favoritedAt == null })),
  remove: (key: string) => write(editLibrary({ type: 'favorite', key, value: false })),
  reorder: (keys: string[]) => write(editLibrary({ type: 'order', keys })),
};
