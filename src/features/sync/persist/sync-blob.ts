import {
  parseBackupJson,
  type Backup,
  type CompactBackup,
} from '../../../core/persist/backup-codec.ts';
import { sha256Hex } from './hash.ts';

/**
 * How a backup is laid out in `browser.storage.sync`, whose limits shape
 * everything here: 100 KB in total, 8 KB per item, and the browser syncs
 * each item on its own.
 *
 *   compact JSON → gzip → base64 → fixed-size string chunks
 *
 * under `nbn.0 … nbn.N-1`, plus `nbn.meta` describing them. Strings, not
 * bytes: Firefox structured-clones sync writes and rejects typed arrays, and
 * base64 is what fits the per-item cap predictably.
 *
 * Because items travel separately, a reader can see a mix of two writes — a
 * "torn" blob. `meta.h` is the hash of the joined base64; when it doesn't
 * match, the reader waits for the rest to arrive rather than applying junk.
 *
 * Pure (no `browser`); the area I/O is in `sync-area.ts`. `node --test`, so
 * relative `.ts` imports — `CompressionStream`, `Blob`, `Response`, `btoa` and
 * `crypto.subtle` are all globals in Node ≥ 20 as well as in the browser.
 */

export const META_KEY = 'nbn.meta';
const CHUNK_PREFIX = 'nbn.';
const BLOB_KEY_RE = /^nbn\.(meta|\d+)$/;

/** Chunk payload length: `nbn.10` (6) + two quotes + 8000 stays under the
 * 8192-byte per-item cap, which Chrome charges as key + JSON of the value. */
export const CHUNK_CHARS = 8000;
export const MAX_CHUNKS = 11;
/** What `fitBackup` gets as its budget: base64 characters. 11 chunks plus
 * meta come to ~88.3 KB of Chrome's 102,400-byte quota. */
export const BUDGET_CHARS = CHUNK_CHARS * MAX_CHUNKS;
export const SYNC_QUOTA_BYTES = 102_400;

/** Bump when a reader of this version could misread the layout. */
export const BLOB_VERSION = 1;

export interface BlobMeta {
  v: number;
  /** Chunk count. */
  n: number;
  /** SHA-256 (hex) of the joined base64 — tear detection and echo recognition. */
  h: string;
  /** `exportedAt` of the backup inside, ms — the last-write-wins clock. */
  at: number;
  /** Writer's app version, for diagnostics only. */
  app: string;
}

export type ReadResult =
  | { kind: 'none' }
  | { kind: 'torn' }
  | { kind: 'ok'; meta: BlobMeta; base64: string };

/** Thrown when a blob was written by a build newer than this one. */
export class NewerVersionError extends Error {
  constructor() {
    super('Synced data was written by a newer version of Note by Note.');
    this.name = 'NewerVersionError';
  }
}

export function isBlobKey(key: string): boolean {
  return BLOB_KEY_RE.test(key);
}

export function chunkKey(index: number): string {
  return `${CHUNK_PREFIX}${index}`;
}

// ---------------------------------------------------------------------------
// gzip / base64

async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function gzipText(text: string): Promise<Uint8Array> {
  return pipe(new TextEncoder().encode(text), new CompressionStream('gzip'));
}

export async function gunzipToText(bytes: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')));
}

/** `btoa` wants a binary string; built in slices to stay clear of argument
 * limits on large buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function chunkString(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// pack / unpack

/** The base64 a compact backup becomes — `fitBackup`'s measure. */
export async function packedChars(compact: CompactBackup): Promise<number> {
  return bytesToBase64(await gzipText(JSON.stringify(compact))).length;
}

export interface PackedBlob {
  /** The items to write, meta included. */
  items: Record<string, string | BlobMeta>;
  meta: BlobMeta;
  /** base64 length, for the usage readout. */
  chars: number;
}

export async function packBackup(compact: CompactBackup, app: string): Promise<PackedBlob> {
  const base64 = bytesToBase64(await gzipText(JSON.stringify(compact)));
  const chunks = chunkString(base64, CHUNK_CHARS);
  if (chunks.length > MAX_CHUNKS) {
    throw new Error("Your library is too large for the browser's sync storage.");
  }
  const meta: BlobMeta = {
    v: BLOB_VERSION,
    n: chunks.length,
    h: await sha256Hex(base64),
    at: compact.at * 1000,
    app,
  };
  const items: Record<string, string | BlobMeta> = { [META_KEY]: meta };
  chunks.forEach((chunk, i) => (items[chunkKey(i)] = chunk));
  return { items, meta, chars: base64.length };
}

/** What the area holds, classified. Only `nbn.*` keys are looked at. */
export async function readBlob(items: Record<string, unknown>): Promise<ReadResult> {
  const meta = items[META_KEY];
  if (meta === undefined) return { kind: 'none' };
  if (
    typeof meta !== 'object' ||
    meta === null ||
    typeof (meta as BlobMeta).v !== 'number' ||
    typeof (meta as BlobMeta).n !== 'number' ||
    typeof (meta as BlobMeta).h !== 'string' ||
    typeof (meta as BlobMeta).at !== 'number'
  ) {
    return { kind: 'torn' };
  }
  const m = meta as BlobMeta;
  if (m.v > BLOB_VERSION) throw new NewerVersionError();
  const chunks: string[] = [];
  for (let i = 0; i < m.n; i++) {
    const chunk = items[chunkKey(i)];
    if (typeof chunk !== 'string') return { kind: 'torn' };
    chunks.push(chunk);
  }
  const base64 = chunks.join('');
  if ((await sha256Hex(base64)) !== m.h) return { kind: 'torn' };
  return { kind: 'ok', meta: m, base64 };
}

export async function unpackBackup(base64: string): Promise<Backup> {
  return parseBackupJson(JSON.parse(await gunzipToText(base64ToBytes(base64))));
}

/** Chrome's accounting for `getBytesInUse`: key length plus the JSON length
 * of the value, per item. */
export function itemsBytes(items: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(items)) {
    total += key.length + JSON.stringify(value).length;
  }
  return total;
}
