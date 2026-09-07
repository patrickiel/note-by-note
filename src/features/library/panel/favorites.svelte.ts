import type { HistoryEntry, TrackIdentity } from '../../../core/model/types';
import { favoriteEntries } from '../../../core/persist/library';
import { editLibrary } from '../../../core/persist/library-client';
import { library } from './library.svelte';

export const favorites = {
  get entries() { return favoriteEntries(library.current); },
  has: (identity: TrackIdentity) => library.current.shared.songs[identity.key]?.favorite.value === true,
  toggle: (entry: HistoryEntry) => editLibrary({ type: 'favorite', key: entry.identity.key,
    value: !library.current.shared.songs[entry.identity.key]?.favorite.value }),
  remove: (key: string) => editLibrary({ type: 'favorite', key, value: false }),
  reorder: (keys: string[]) => editLibrary({ type: 'order', keys }),
};
