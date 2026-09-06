import { isRecord } from '../../../core/persist/backup-format.ts';
import { sha256Hex } from './hash.ts';
import { NewerVersionError, parseSyncSnapshot, type SyncSnapshot } from './sync-snapshot.ts';

/**
 * How a `SyncSnapshot` is laid out in `browser.storage.sync`: JSON → gzip →
 * base64 → fixed-size string chunks under `nbn.0 … nbn.N-1`, plus `nbn.meta`
 * describing them. Chrome and Firefox both cap the area at 100 KB total and
 * 8 KB per item (Chrome measures an item as `key.length +
 * JSON.stringify(value).length`), so the blob has to be split, and every
 * value stays a string or a plain object — Firefox structured-clones writes
 * and rejects typed arrays.
 *
 * Browser sync merges per key, so two devices writing at once can leave the
 * area with chunks from different blobs. `meta.hash` (over the whole base64
 * string) catches that: a mismatch reads as `torn`, and the reader waits for
 * the next change instead of applying garbage.
 *
 * Pure: runs under `node --test` (Node ≥ 22 has `CompressionStream`,
 * `crypto.subtle` and `btoa` as globals).
 */

export const META_KEY = 'nbn.meta';
const CHUNK_PREFIX = 'nbn.';
const BLOB_KEY_RE = /^nbn\.(meta|\d+)$/;

/** Chunk payload length. `nbn.10` (6) + two quotes + 8000 < 8192. */
export const CHUNK_CHARS = 8000;
/** 11 × ~8 KB plus the meta item stays well under the 102,400-byte area,
 * with room for a foreign key or two. */
export const MAX_CHUNKS = 11;
/** The budget `fit.ts` trims to, measured in base64 characters — the unit
 * the quota is actually charged in. */
export const BUDGET_CHARS = CHUNK_CHARS * MAX_CHUNKS;

/** The whole area, Chrome and Firefox alike (`storage.sync.QUOTA_BYTES`). */
export const SYNC_QUOTA_BYTES = 102_400;

export const BLOB_VERSION = 2 as const;

/** Bytes an item set occupies by Chrome's accounting — key length plus the
 * JSON length of each value — which is what the quota is charged in. */
export function itemsBytes(items: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(items)) {
    total += key.length + JSON.stringify(value).length;
  }
  return total;
}

export interface BlobMeta {
  v: typeof BLOB_VERSION;
  chunks: number;
  /** SHA-256 of the joined base64 string. */
  hash: string;
  updatedAt: number;
  appVersion: string;
}

export interface EncodedBlob {
  meta: BlobMeta;
  chunks: string[];
  /** Base64 length — what the budget is measured against. */
  size: number;
}

export type ReadResult =
  | { kind: 'none' }
  | { kind: 'torn' }
  | { kind: 'ok'; meta: BlobMeta; snapshot: SyncSnapshot };

export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipToText(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** `Uint8Array.prototype.toBase64` needs Chrome 140; this runs on 116. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + 0x8000) as unknown as number[],
    );
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function chunkKey(index: number): string {
  return `${CHUNK_PREFIX}${index}`;
}

export function isBlobKey(key: string): boolean {
  return BLOB_KEY_RE.test(key);
}

/** Index of a chunk key, or null for `nbn.meta` and foreign keys. */
export function chunkIndex(key: string): number | null {
  const m = BLOB_KEY_RE.exec(key);
  return m && m[1] !== 'meta' ? Number(m[1]) : null;
}

export function chunkString(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

export async function encodeSnapshot(
  snapshot: SyncSnapshot,
  chunkChars = CHUNK_CHARS,
): Promise<EncodedBlob> {
  const b64 = bytesToBase64(await gzipText(JSON.stringify(snapshot)));
  const chunks = chunkString(b64, chunkChars);
  return {
    meta: {
      v: BLOB_VERSION,
      chunks: chunks.length,
      hash: await sha256Hex(b64),
      updatedAt: snapshot.exportedAt,
      appVersion: snapshot.appVersion,
    },
    chunks,
    size: b64.length,
  };
}

export function blobToItems(blob: EncodedBlob): Record<string, unknown> {
  const items: Record<string, unknown> = { [META_KEY]: blob.meta };
  blob.chunks.forEach((chunk, i) => (items[chunkKey(i)] = chunk));
  return items;
}

/** Reads the area's items back into a snapshot. `torn` covers every
 * inconsistency a concurrent write could produce — a missing chunk, a stale
 * one, a malformed meta — because all of them heal on that writer's next
 * push. Only a blob from a newer build is an error worth showing. */
export async function decodeItems(items: Record<string, unknown>): Promise<ReadResult> {
  const meta = items[META_KEY];
  if (meta === undefined) return { kind: 'none' };
  if (!isRecord(meta) || typeof meta.v !== 'number') return { kind: 'torn' };
  if (meta.v > BLOB_VERSION) throw new NewerVersionError();
  if (typeof meta.chunks !== 'number' || typeof meta.hash !== 'string') return { kind: 'torn' };
  const chunks: string[] = [];
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = items[chunkKey(i)];
    if (typeof chunk !== 'string') return { kind: 'torn' };
    chunks.push(chunk);
  }
  const b64 = chunks.join('');
  if ((await sha256Hex(b64)) !== meta.hash) return { kind: 'torn' };
  const json = await gunzipToText(base64ToBytes(b64));
  return {
    kind: 'ok',
    meta: meta as unknown as BlobMeta,
    snapshot: parseSyncSnapshot(JSON.parse(json)),
  };
}
