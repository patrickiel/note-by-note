import { recentEntries } from '../../../core/persist/library';
import { editLibrary } from '../../../core/persist/library-client';
import { library } from '../../../core/state/library.svelte';

export const history = {
  get entries() { return recentEntries(library.current); },
  remove: (key: string) => editLibrary({ type: 'recent.remove', key }),
  clear: () => editLibrary({ type: 'recent.remove' }),
};
