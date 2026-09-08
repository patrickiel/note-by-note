import type { SharedLibrary } from '../../../core/persist/library';
import { parseShared } from '../../../core/persist/backup-codec.ts';

export const PREFIX = 'nbn:';
export const SNAPSHOT_KEY = PREFIX + 'library';
export const QUOTA_BYTES = 102400;
const CHUNK_SIZE = 7800; // Leaves room for the key and JSON below the 8192-byte item limit.
const MAX_CHUNKS = Math.ceil(QUOTA_BYTES / CHUNK_SIZE);
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
export async function hash(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class IncompleteSnapshot extends Error {
  readonly updatedAt: number | null;
  constructor(updatedAt: number | null) {
    super('Waiting for the complete synced library. All data is kept on this device.');
    this.updatedAt = updatedAt;
  }
}

/** No partial library is ever applied, even if browser sync delivers keys separately. */
export async function readSnapshot(items: Record<string, any>): Promise<SharedLibrary | null> {
  const header = items[SNAPSHOT_KEY];
  if (!header) {
    if (Object.keys(items).some((key) => key.startsWith(PREFIX + 'chunk:'))) {
      // A lost header need not lose the snapshot: gzip verifies its own checksum.
      // Recover its revision from complete slots before choosing which copy wins.
      const chunks = Array.from({ length: MAX_CHUNKS }, (_, n) => items[PREFIX + 'chunk:' + n] ?? '');
      try {
        if (chunks.some((chunk) => typeof chunk !== 'string')) throw new Error('Damaged chunk.');
        return parseShared(JSON.parse(await decompress(chunks.join(''))));
      } catch { throw new IncompleteSnapshot(null); }
    }
    return null;
  }
  if (header.version !== 1) throw new Error('Unsupported synced data. Update Note by Note on all devices.');
  if (!Number.isFinite(header.updatedAt) || header.updatedAt < 0 || !Number.isInteger(header.chunks)
    || header.chunks < 1 || header.chunks > MAX_CHUNKS || typeof header.hash !== 'string') {
    throw new Error('Damaged synced library.');
  }
  const chunks = Array.from({ length: header.chunks }, (_, n) => items[PREFIX + 'chunk:' + n]);
  if (chunks.some((chunk) => typeof chunk !== 'string') || await hash(chunks.join('')) !== header.hash) {
    throw new IncompleteSnapshot(header.updatedAt);
  }
  const snapshot = parseShared(JSON.parse(await decompress(chunks.join(''))));
  if (snapshot.updatedAt !== header.updatedAt) throw new Error('Damaged synced library revision.');
  return snapshot;
}

/** Upload the entire snapshot or report capacity failure before changing storage. */
export async function encodeSnapshot(shared: SharedLibrary, existing: Record<string, unknown> = {}): Promise<{ items: Record<string, unknown>; usedBytes: number }> {
  const data = await compress(JSON.stringify(shared));
  const items: Record<string, unknown> = {
    [SNAPSHOT_KEY]: { version: 1, updatedAt: shared.updatedAt, chunks: Math.ceil(data.length / CHUNK_SIZE), hash: await hash(data) },
  };
  // Fixed slots let a smaller snapshot clear its old tail in the same set() call.
  for (let n = 0; n < MAX_CHUNKS; n++) items[PREFIX + 'chunk:' + n] = data.slice(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE);
  const usedBytes = bytesUsed({ ...existing, ...items });
  if (data.length > CHUNK_SIZE * MAX_CHUNKS || usedBytes > QUOTA_BYTES
    || Object.keys({ ...existing, ...items }).length > 512) {
    throw new Error('Browser sync storage is full. All data is kept on this device; export a backup to transfer it.');
  }
  return { items, usedBytes };
}

/**
 * The same upload, made to fit by dropping the least recently used songs that
 * are not favorites. Settings, presets, favorite order, every favorite and the
 * song in hand are kept, so an overflow of those alone still reports capacity
 * failure rather than trimming its way to an empty library.
 *
 * Dropping more songs can only shrink the payload, so the smallest prefix that
 * fits is found by bisection — a handful of compressions instead of one per song.
 */
export async function fitSnapshot(shared: SharedLibrary, lastAccessed: Record<string, number>,
  existing: Record<string, unknown> = {}) {
  const age = (key: string) => lastAccessed[key] ?? shared.songs[key].practice.updatedAt;
  // The song being practised right now is never a candidate: one song too big to
  // sync must report capacity failure, not empty the library to make itself fit.
  const droppable = Object.keys(shared.songs)
    .filter((key) => shared.songs[key].favoritedAt == null)
    .sort((a, b) => age(a) - age(b))
    .slice(0, -1);
  const without = (count: number): SharedLibrary => {
    if (count === 0) return shared;
    const dropped = new Set(droppable.slice(0, count));
    return { ...shared, songs: Object.fromEntries(Object.entries(shared.songs).filter(([key]) => !dropped.has(key))) };
  };
  const attempt = async (count: number) => {
    try { return { ok: true as const, count, ...await encodeSnapshot(without(count), existing) }; }
    catch (error) { return { ok: false as const, error }; }
  };

  const whole = await attempt(0);
  if (whole.ok) return { items: whole.items, usedBytes: whole.usedBytes, shared, dropped: [] as string[] };
  if (!droppable.length) throw whole.error;
  // The bisection assumes both ends are known: everything still over budget has
  // nothing left to give up, so report the original capacity failure.
  let fitted = await attempt(droppable.length);
  if (!fitted.ok) throw fitted.error;
  let lo = 1;
  let hi = droppable.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const result = await attempt(mid);
    if (result.ok) { fitted = result; hi = mid; } else lo = mid + 1;
  }
  return { items: fitted.items, usedBytes: fitted.usedBytes,
    shared: without(fitted.count), dropped: droppable.slice(0, fitted.count) };
}
