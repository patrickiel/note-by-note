import { emptyLibrary, type Library } from '../../../core/persist/library';
import { readLibrary, watchLibrary } from '../../../core/persist/library-client';

class LibraryStore {
  current = $state.raw<Library>(emptyLibrary());
  async init() {
    let changed = false;
    watchLibrary((library) => library, (library) => { changed = true; this.current = library; });
    const initial = await readLibrary();
    if (!changed) this.current = initial;
  }
}
export const library = new LibraryStore();
