import { emptyLibrary, type Library } from '../persist/library';
import { libraryItem, readLibrary } from '../persist/library-client';

/** One panel-side copy. Settings, preferences, presets and song lists read it. */
class LibraryStore {
  current = $state.raw<Library>(emptyLibrary());
  async init() {
    let changed = false;
    libraryItem.watch((value) => { changed = true; this.current = value ?? emptyLibrary(); });
    const initial = await readLibrary();
    if (!changed) this.current = initial;
  }
}
export const library = new LibraryStore();
