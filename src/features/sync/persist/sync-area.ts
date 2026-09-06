import { SnapshotTooLargeError } from './fit';
import {
  blobToItems,
  chunkIndex,
  decodeItems,
  isBlobKey,
  itemsBytes,
  type EncodedBlob,
  type ReadResult,
} from './sync-blob';
import { NewerVersionError } from './sync-snapshot';

/**
 * The `browser.storage.sync` side of the blob layout in `sync-blob.ts`.
 * Reads are unmetered; writes count against 120/min and 1,800/h per `set`,
 * `remove` or `clear` call, whatever the number of keys — so a push is one
 * or two operations, and the caller keeps them spaced.
 */

/** `bytes` is the whole area's occupancy (foreign keys included), valid
 * whatever the read's outcome. */
export async function readSyncArea(): Promise<ReadResult & { bytes: number }> {
  const items = await browser.storage.sync.get(null);
  return { ...(await decodeItems(items)), bytes: itemsBytes(items) };
}

/**
 * Writes the blob, then drops chunks a longer previous blob left above the
 * new count. Set-then-remove is the safe order: a reader that sees the new
 * meta with stale extras ignores them (it only reads up to `meta.chunks`);
 * one that sees the old meta with new chunks fails the hash and reads
 * `torn`.
 */
export async function writeSyncArea(blob: EncodedBlob): Promise<void> {
  const existing = await browser.storage.sync.get(null);
  await browser.storage.sync.set(blobToItems(blob));
  const stale = Object.keys(existing).filter((key) => {
    const i = chunkIndex(key);
    return i !== null && i >= blob.chunks.length;
  });
  if (stale.length) await browser.storage.sync.remove(stale);
}

/** Removes the blob only — anything else in the area is left alone. */
export async function clearSyncArea(): Promise<void> {
  const existing = await browser.storage.sync.get(null);
  const keys = Object.keys(existing).filter(isBlobKey);
  if (keys.length) await browser.storage.sync.remove(keys);
}

export type SyncAreaChanges = Record<string, { newValue?: unknown; oldValue?: unknown }>;

/** Fires for the blob's keys only, for our own writes as well as remote ones
 * (the caller tells them apart by `meta.hash`). */
export function onSyncAreaChanged(listener: (changes: SyncAreaChanges) => void): void {
  browser.storage.sync.onChanged.addListener((changes) => {
    const ours: SyncAreaChanges = {};
    for (const [key, change] of Object.entries(changes)) {
      if (isBlobKey(key)) ours[key] = change;
    }
    if (Object.keys(ours).length) listener(ours);
  });
}

export type SyncErrorKind = 'rate' | 'bytes' | 'newer' | 'other';

/** The browser reports quota failures as plain errors whose messages name
 * the constant that was exceeded. */
export function classifySyncError(err: unknown): SyncErrorKind {
  if (err instanceof NewerVersionError) return 'newer';
  if (err instanceof SnapshotTooLargeError) return 'bytes';
  const message = err instanceof Error ? err.message : String(err);
  if (/MAX_WRITE_OPERATIONS|MAX_SUSTAINED_WRITE/i.test(message)) return 'rate';
  if (/QUOTA_BYTES|QuotaExceeded|quota/i.test(message)) return 'bytes';
  return 'other';
}

export function syncErrorMessage(err: unknown): string {
  switch (classifySyncError(err)) {
    case 'rate':
      return 'Browser sync is rate-limited — retrying shortly.';
    case 'bytes':
      return "Your library is too large for the browser's sync storage.";
    case 'newer':
      return 'Synced data was written by a newer version of Note by Note.';
    default:
      return err instanceof Error ? err.message : 'Sync failed.';
  }
}
