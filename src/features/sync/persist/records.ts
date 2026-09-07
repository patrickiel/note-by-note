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
async function hash(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class IncompleteSnapshot extends Error {
  readonly updatedAt: number;
  constructor(updatedAt: number) {
    super('Waiting for the complete synced library. All data is kept on this device.');
    this.updatedAt = updatedAt;
  }
}

/** No partial library is ever applied, even if browser sync delivers keys separately. */
export async function readSnapshot(items: Record<string, any>): Promise<SharedLibrary | null> {
  const header = items[SNAPSHOT_KEY];
  if (!header) {
    if (Object.keys(items).some((key) => key.startsWith(PREFIX + 'chunk:'))) throw new IncompleteSnapshot(Infinity);
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
export async function encodeSnapshot(shared: SharedLibrary, existing: Record<string, unknown> = {}) {
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
