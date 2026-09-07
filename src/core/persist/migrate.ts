import { storage } from '#imports';
import type { TrackData } from '../model/types';
import { rekeyByIdentity } from './rekey';
import { favoritesItem, historyItem, removeTrackDataExcept, saveTrackData } from './storage';

/**
 * One-shot storage migrations, run once at panel boot before any store reads.
 *
 * Local only. The wire format needs no migration of its own: a compact backup
 * stores a song as `[url, title, duration]` and every build derives the key it
 * uses from those, so a device on either side of a key change reads the other's
 * blob and re-encodes it identically (`backup-codec.ts`).
 */

/** 2: `TrackIdentity.key` stopped being `hash(url):duration` and became
 * `songKey` (url + title) — one key for the track record, the library lists
 * and the tombstones alike. See `track-identity.ts`. */
const SCHEMA_VERSION = 2;

const schemaVersionItem = storage.defineItem<number>('local:schemaVersion', { fallback: 0 });

/** Track records live one per storage key, so they are rewritten under the new
 * key and the old ones removed afterwards — written first, never wiped first,
 * the same order `restoreBackup` uses and for the same reason: interrupted
 * halfway this leaves a stale record behind, never a missing one. */
async function rekeyTrackData(): Promise<void> {
  const snapshot = await browser.storage.local.get(null);
  const records = Object.entries(snapshot)
    .filter(([key]) => key.startsWith('track:'))
    .map(([, value]) => value as TrackData);
  const kept = rekeyByIdentity(records);
  await Promise.all(kept.map(saveTrackData));
  await removeTrackDataExcept(new Set(kept.map((t) => t.identity.key)));
}

/** Idempotent, and cheap on the common path — one storage read when there is
 * nothing to do. Awaited before the stores load so nothing reads half-migrated
 * data; a failure is left to throw, since booting the panel onto keys that
 * don't match its storage would be worse than not booting. */
export async function migrateStorage(): Promise<void> {
  const from = await schemaVersionItem.getValue();
  if (from >= SCHEMA_VERSION) return;

  if (from < 2) {
    const [history, favorites] = await Promise.all([
      historyItem.getValue(),
      favoritesItem.getValue(),
    ]);
    await rekeyTrackData();
    await Promise.all([
      historyItem.setValue(rekeyByIdentity(history)),
      favoritesItem.setValue(rekeyByIdentity(favorites)),
    ]);
  }

  await schemaVersionItem.setValue(SCHEMA_VERSION);
}
