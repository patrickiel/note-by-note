import { recentEntries } from '../../../core/persist/library';
import { editLibrary } from '../../../core/persist/library-client';
import { library } from '../../../core/state/library.svelte';

class HistoryStore {
  /** Derived, not a getter: see the note in favorites.svelte.ts. */
  entries = $derived(recentEntries(library.current));

  remove(key: string) { return editLibrary({ type: 'recent.remove', key }); }
  clear() { return editLibrary({ type: 'recent.remove' }); }
}
export const history = new HistoryStore();
