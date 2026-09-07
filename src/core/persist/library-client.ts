import { storage } from '#imports';
import { sendMessage } from '../messaging/rpc';
import { emptyLibrary, type Library, type LibraryCommand } from './library';

/** Panels observe the library; the background is its only writer. */
export const libraryItem = storage.defineItem<Library>('local:library', { fallback: emptyLibrary() });
export const readLibrary = () => sendMessage('libraryRead', undefined);
export const editLibrary = (command: LibraryCommand) =>
  sendMessage('libraryEdit', JSON.parse(JSON.stringify(command)) as LibraryCommand);

export function watchLibrary<T>(select: (library: Library) => T, listener: (value: T) => void) {
  return libraryItem.watch((value) => listener(select(value ?? emptyLibrary())));
}
