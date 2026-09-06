// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes,
  blobToItems,
  bytesToBase64,
  CHUNK_CHARS,
  chunkIndex,
  chunkKey,
  chunkString,
  decodeItems,
  encodeSnapshot,
  gunzipToText,
  gzipText,
  isBlobKey,
  itemsBytes,
  META_KEY,
  SYNC_QUOTA_BYTES,
} from './sync-blob.ts';
import { NewerVersionError, SYNC_FORMAT_VERSION, type SyncSnapshot } from './sync-snapshot.ts';

/** Chrome's per-item accounting. */
const itemBytes = (key: string, value: unknown) => key.length + JSON.stringify(value).length;

function snapshot(tracks = 40): SyncSnapshot {
  return {
    v: SYNC_FORMAT_VERSION,
    exportedAt: 1_700_000_000_000,
    appVersion: '1.2.3',
    settings: { theme: 'auto' } as unknown as SyncSnapshot['settings'],
    uiPrefs: {} as SyncSnapshot['uiPrefs'],
    history: [],
    favorites: [],
    eqPresets: [],
    tracks: Array.from({ length: tracks }, (_, i) => ({
      identity: {
        key: `k${i}:240`,
        normalizedUrl: `https://www.youtube.com/watch?v=${i.toString(36).padStart(11, 'x')}`,
        title: `Song number ${i} with a fairly long title`,
        durationSec: 240,
      },
      markers: Array.from({ length: 8 }, (_, m) => ({
        id: `${i}-${m}-${Math.random()}`,
        t: m * 17.3 + Math.random(),
        label: `marker ${m}`,
      })),
      snippets: [],
      sequenceLoop: false,
      sequenceCountIn: false,
      updatedAt: 1,
      chart: {
        t: Array.from({ length: 200 }, () => 100 + Math.floor(Math.random() * 100)),
        d: Array.from({ length: 200 }, () => 100 + Math.floor(Math.random() * 100)),
        l: Array.from({ length: 200 }, () => ['C', 'Am', 'F', 'G'][Math.floor(Math.random() * 4)]),
        key: null,
        coverage: 1,
        analyzedFrom: 0,
        analyzedTo: 24000,
        computedAt: 1,
      },
    })),
    deleted: {},
    trimmed: false,
  };
}

test('base64 round-trips every byte value and a large random buffer', () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(base64ToBytes(bytesToBase64(all)), all);
  const big = new Uint8Array(100_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
});

test('gzip round-trips text', async () => {
  const text = 'ø'.repeat(1000) + JSON.stringify(snapshot(3));
  assert.equal(await gunzipToText(await gzipText(text)), text);
});

test('chunkString stays within the chunk size and concatenates back', () => {
  const text = 'x'.repeat(CHUNK_CHARS * 2 + 5);
  const chunks = chunkString(text);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= CHUNK_CHARS));
  assert.equal(chunks.join(''), text);
  assert.deepEqual(chunkString(''), ['']);
});

test('blob keys', () => {
  assert.equal(chunkKey(3), 'nbn.3');
  assert.ok(isBlobKey(META_KEY));
  assert.ok(isBlobKey('nbn.10'));
  assert.ok(!isBlobKey('syncId'));
  assert.ok(!isBlobKey('nbn.x'));
  assert.equal(chunkIndex('nbn.7'), 7);
  assert.equal(chunkIndex(META_KEY), null);
  assert.equal(chunkIndex('other'), null);
});

test('encode → items → decode round-trips and respects the per-item limit', async () => {
  const s = snapshot();
  const blob = await encodeSnapshot(s);
  assert.ok(blob.chunks.length > 1, 'fixture should span several chunks');
  assert.equal(blob.meta.chunks, blob.chunks.length);
  assert.equal(blob.size, blob.chunks.join('').length);
  const items = blobToItems(blob);
  let total = 0;
  for (const [key, value] of Object.entries(items)) {
    assert.ok(itemBytes(key, value) <= 8192, `${key} is ${itemBytes(key, value)} bytes`);
    total += itemBytes(key, value);
  }
  assert.equal(itemsBytes(items), total);
  assert.ok(total <= SYNC_QUOTA_BYTES);
  const read = await decodeItems(items);
  assert.equal(read.kind, 'ok');
  if (read.kind === 'ok') {
    assert.deepEqual(read.snapshot, s);
    assert.equal(read.meta.hash, blob.meta.hash);
  }
});

test('a missing or corrupted chunk reads as torn; an empty area as none', async () => {
  const items = blobToItems(await encodeSnapshot(snapshot()));
  assert.deepEqual(await decodeItems({}), { kind: 'none' });

  const missing = { ...items };
  delete missing[chunkKey(1)];
  assert.deepEqual(await decodeItems(missing), { kind: 'torn' });

  const corrupt = { ...items };
  const chunk = corrupt[chunkKey(0)] as string;
  corrupt[chunkKey(0)] = (chunk[0] === 'A' ? 'B' : 'A') + chunk.slice(1);
  assert.deepEqual(await decodeItems(corrupt), { kind: 'torn' });

  const junkMeta = { ...items, [META_KEY]: 'oops' };
  assert.deepEqual(await decodeItems(junkMeta), { kind: 'torn' });

  // Chunks beyond meta.chunks (a stale removal still in flight) are ignored.
  const extra = { ...items, [chunkKey(99)]: 'stale' };
  assert.equal((await decodeItems(extra)).kind, 'ok');
});

test('a blob from a newer build is an error, not torn', async () => {
  const items = blobToItems(await encodeSnapshot(snapshot(2)));
  const meta = items[META_KEY] as { v: number };
  await assert.rejects(
    decodeItems({ ...items, [META_KEY]: { ...meta, v: meta.v + 1 } }),
    NewerVersionError,
  );
});
