import { storage } from '#imports';
import { sendMessage } from '../messaging/rpc';
import { emptyLibrary, type Library, type LibraryCommand } from './library';

/** Panels observe the library; the background is its only writer. */
export const libraryItem = storage.defineItem<Library>('local:library', { fallback: emptyLibrary() });
export const readLibrary = async () => sendMessage('libraryRead', undefined);
export const editLibrary = async (command: LibraryCommand): Promise<void> => {
  await sendMessage('libraryEdit', JSON.parse(JSON.stringify(command)) as LibraryCommand);
};
