import { storage } from '#imports';
import { sendMessage } from '../messaging/rpc';
import { canonical, emptyLibrary, type Library, type LibraryCommand } from './library';

/** Panels observe the library; the background is its only writer. */
export const libraryItem = storage.defineItem<Library>('local:library', { fallback: emptyLibrary() });
export const readLibrary = async () => await sendMessage('libraryRead', undefined);
export const editLibrary = async (command: LibraryCommand): Promise<void> => {
  await sendMessage('libraryEdit', JSON.parse(JSON.stringify(command)) as LibraryCommand);
};

export function watchLibrary<T>(select: (library: Library) => T, listener: (value: T) => void) {
  return libraryItem.watch((value, previous) => {
    const selected = select(value ?? emptyLibrary());
    if (canonical(selected) !== canonical(select(previous ?? emptyLibrary()))) listener(selected);
  });
}
