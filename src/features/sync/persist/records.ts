import { canonical, emptyLibrary, type SharedLibrary } from '../../../core/persist/library.ts';
import { parseShared } from '../../../core/persist/backup-codec.ts';
import { migrateBackup } from '../../../core/persist/library-migration.ts';
import { parseBackupJson as parseLegacy } from '../../../core/persist/legacy-backup.ts';

export const PREFIX = 'nbn4:';
export const QUOTA_BYTES = 102400;
const encoder = new TextEncoder();
export const bytesUsed = (items: Record<string, unknown>) => Object.entries(items)
  .reduce((total, [key, value]) => total + encoder.encode(key + JSON.stringify(value)).length, 0);
export const legacyKeys = (items: Record<string, unknown>) => Object.keys(items).filter((key) => /^nbn\.(meta|\d+)$/.test(key) || key === 'syncId');

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
export function records(shared: SharedLibrary): Record<string, unknown> {
  return Object.fromEntries([
    [PREFIX + 'settings', shared.settings], [PREFIX + 'order', shared.favoriteOrder],
    ...Object.entries(shared.songs).map(([key, value]) => [PREFIX + 'song:' + key, value]),
    ...Object.entries(shared.presets).map(([key, value]) => [PREFIX + 'preset:' + key, value]),
  ]);
}
export async function readRecords(items: Record<string, unknown>): Promise<SharedLibrary> {
  const shared = emptyLibrary().shared;
  const keys = Object.keys(items).filter((key) => key.startsWith(PREFIX));
  for (const key of keys) {
    const item = items[key] as { version: number; data: string };
    if (item?.version !== 4 || typeof item.data !== 'string') throw new Error('Unsupported synced data. Update Note by Note on all devices.');
    const value = JSON.parse(await decompress(item.data));
    const name = key.slice(PREFIX.length);
    if (name === 'settings') shared.settings = value;
    else if (name === 'order') shared.favoriteOrder = value;
    else if (name.startsWith('song:')) Object.defineProperty(shared.songs, name.slice(5), { value, enumerable: true, writable: true, configurable: true });
    else if (name.startsWith('preset:')) Object.defineProperty(shared.presets, name.slice(7), { value, enumerable: true, writable: true, configurable: true });
    else throw new Error('Unsupported synced record. Update Note by Note on all devices.');
  }
  // One-time read of the previous shared blob. Never write that format again.
  if (!keys.length && items['nbn.meta']) {
    const meta = items['nbn.meta'] as { v: number; n: number; h: string };
    if (meta.v !== 1 || !Number.isInteger(meta.n) || meta.n < 1 || meta.n > 12) throw new Error('Unsupported legacy sync data.');
    const chunks = Array.from({ length: meta.n }, (_, i) => items['nbn.' + i]);
    if (chunks.some((chunk) => typeof chunk !== 'string')) throw new Error('Previous sync data is still arriving. Try again shortly.');
    const base64 = chunks.join('');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(base64)));
    if ([...digest].map((n) => n.toString(16).padStart(2, '0')).join('') !== meta.h) throw new Error('Previous sync data is still arriving. Try again shortly.');
    return migrateBackup(parseLegacy(JSON.parse(await decompress(base64)))).shared;
  }
  return parseShared(shared);
}
/** Write complete independent records. There is no chunk assembly or truncation. */
export async function changedRecords(local: SharedLibrary, remote: SharedLibrary, existing: Record<string, unknown>) {
  const previous = records(remote);
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(records(local))) {
    if (existing[key] !== undefined && canonical(value) === canonical(previous[key])) continue;
    const item = { version: 4, data: await compress(canonical(value)) };
    if (bytesUsed({ [key]: item }) > 8192) throw new Error('A saved record is too large to sync. All data is kept on this device; export a backup to transfer it.');
    changes[key] = item;
  }
  const proposed = { ...existing, ...changes };
  for (const key of legacyKeys(proposed)) delete proposed[key];
  if (bytesUsed(proposed) > QUOTA_BYTES || Object.keys(proposed).length > 512) {
    throw new Error('Browser sync storage is full. All data is kept on this device; export a backup to transfer it.');
  }
  return changes;
}
