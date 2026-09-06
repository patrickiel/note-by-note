import { LibraryTooLargeError } from './fit';
import {
  chunkKey,
  isBlobKey,
  itemsBytes,
  NewerVersionError,
  readBlob,
  type BlobMeta,
  type ReadResult,
} from './sync-blob';

/**
 * The `browser.storage.sync` side of the blob layout in `sync-blob.ts`:
 * reading what the browser has synced in, writing a packed blob, clearing it.
 * Reads are local and free; writes are what the browser meters (120/min,
 * 1800/hour, 100 KB), so the store spaces them out.
 */

/** The pre-storage.sync builds kept the server sync ID here. */
const LEGACY_KEYS = ['syncId'];

export interface AreaRead {
  result: ReadResult;
  /** Everything in the area, foreign keys included — what the quota sees. */
  bytes: number;
}

export async function readSyncArea(): Promise<AreaRead> {
  const items = (await browser.storage.sync.get(null)) as Record<string, unknown>;
  return { result: await readBlob(items), bytes: itemsBytes(items) };
}

/** Writes the blob, then drops chunks a larger earlier blob left behind and
 * any legacy key. Two calls — a `set` can't remove — so a reader in between
 * sees extra chunks, which `readBlob` ignores. */
export async function writeSyncArea(items: Record<string, string | BlobMeta>): Promise<void> {
  const before = (await browser.storage.sync.get(null)) as Record<string, unknown>;
  await browser.storage.sync.set(items);
  const stale = Object.keys(before).filter(
    (key) => (isBlobKey(key) && !(key in items)) || LEGACY_KEYS.includes(key),
  );
  if (stale.length) await browser.storage.sync.remove(stale);
}

export async function clearSyncArea(): Promise<void> {
  const items = (await browser.storage.sync.get(null)) as Record<string, unknown>;
  const keys = Object.keys(items).filter((key) => isBlobKey(key) || LEGACY_KEYS.includes(key));
  if (keys.length) await browser.storage.sync.remove(keys);
}

/** Fires when the browser syncs in a change to the blob (or one of our own
 * writes lands). `storage.onChanged` with the area filter rather than
 * `storage.sync.onChanged`, which older Firefox lacks. */
export function onSyncAreaChanged(listener: () => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (Object.keys(changes).some((key) => isBlobKey(key) || key === chunkKey(0))) listener();
  });
}

export type SyncErrorKind = 'rate' | 'quota' | 'newer' | 'other';

/** The browser reports quota trouble as thrown strings/errors with these
 * names in the message; there is no error code to switch on. */
export function classifySyncError(err: unknown): SyncErrorKind {
  if (err instanceof NewerVersionError) return 'newer';
  if (err instanceof LibraryTooLargeError) return 'quota';
  const text = err instanceof Error ? err.message : String(err);
  if (/MAX_WRITE_OPERATIONS|MAX_SUSTAINED_WRITE|MAX_ITEMS/i.test(text)) return 'rate';
  if (/QUOTA_BYTES|QuotaExceeded|quota/i.test(text)) return 'quota';
  return 'other';
}

export function syncErrorMessage(err: unknown): string {
  switch (classifySyncError(err)) {
    case 'rate':
      return 'The browser is rate-limiting sync writes — retrying in a minute.';
    case 'quota':
      return "Your library is too large for the browser's sync storage.";
    case 'newer':
      return 'Synced data was written by a newer version of Note by Note.';
    default:
      return err instanceof Error && err.message ? err.message : 'Sync failed.';
  }
}
