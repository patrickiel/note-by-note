import { canonical, defineEntry, emptyLibrary, type SharedLibrary } from '../../../core/persist/library.ts';
import { parseShared } from '../../../core/persist/backup-codec.ts';

export const PREFIX = 'nbn4:';
/** `browser.storage.sync` caps the whole area, one item, and the item count. */
export const QUOTA_BYTES = 102400;
const ITEM_BYTES = 8192;
const ITEM_COUNT = 512;
const encoder = new TextEncoder();
export const bytesUsed = (items: Record<string, unknown>) => Object.entries(items)
  .reduce((total, [key, value]) => total + encoder.encode(key + JSON.stringify(value)).length, 0);

async function compress(text: string): Promise<string> {
  const buffer = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function decompress(data: string): Promise<string> {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
function records(shared: SharedLibrary): Record<string, unknown> {
  return Object.fromEntries([
    [PREFIX + 'settings', shared.settings], [PREFIX + 'order', shared.favoriteOrder],
    ...Object.entries(shared.songs).map(([key, value]) => [PREFIX + 'song:' + key, value]),
    ...Object.entries(shared.presets).map(([key, value]) => [PREFIX + 'preset:' + key, value]),
  ]);
}
export async function readRecords(items: Record<string, unknown>): Promise<SharedLibrary> {
  const shared = emptyLibrary().shared;
  for (const key of Object.keys(items).filter((key) => key.startsWith(PREFIX))) {
    const item = items[key] as { version: number; data: string };
    if (item?.version !== 4 || typeof item.data !== 'string') throw new Error('Unsupported synced data. Update Note by Note on all devices.');
    const value = JSON.parse(await decompress(item.data));
    const name = key.slice(PREFIX.length);
    if (name === 'settings') shared.settings = value;
    else if (name === 'order') shared.favoriteOrder = value;
    else if (name.startsWith('song:')) defineEntry(shared.songs, name.slice(5), value);
    else if (name.startsWith('preset:')) defineEntry(shared.presets, name.slice(7), value);
    else throw new Error('Unsupported synced record. Update Note by Note on all devices.');
  }
  return parseShared(shared);
}
/** One record that cannot fit is reported and left behind, never truncated. */
export interface RecordChanges { changes: Record<string, unknown>; skipped: string[]; usedBytes: number }
export const skippedMessage = (skipped: string[]) => `${skipped.length} saved ${skipped.length === 1
  ? 'record is' : 'records are'} too large to sync. Everything else synced; all data is kept on this device.`;

/** Write complete independent records. There is no chunk assembly or truncation. */
export async function changedRecords(local: SharedLibrary, remote: SharedLibrary, existing: Record<string, unknown>): Promise<RecordChanges> {
  const previous = records(remote);
  const changes: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(records(local))) {
    if (existing[key] !== undefined && canonical(value) === canonical(previous[key])) continue;
    const item = { version: 4, data: await compress(canonical(value)) };
    // One outsized song must not hold back every other record for good.
    if (encoder.encode(key + JSON.stringify(item)).length > ITEM_BYTES) { skipped.push(key); continue; }
    changes[key] = item;
  }
  const proposed = { ...existing, ...changes };
  const usedBytes = bytesUsed(proposed);
  if (usedBytes > QUOTA_BYTES || Object.keys(proposed).length > ITEM_COUNT) {
    throw new Error('Browser sync storage is full. All data is kept on this device; export a backup to transfer it.');
  }
  return { changes, skipped, usedBytes };
}
