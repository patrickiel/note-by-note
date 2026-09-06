// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes,
  BUDGET_CHARS,
  bytesToBase64,
  CHUNK_CHARS,
  chunkKey,
  chunkString,
  gunzipToText,
  gzipText,
  isBlobKey,
  itemsBytes,
  MAX_CHUNKS,
  META_KEY,
  NewerVersionError,
  packBackup,
  packedChars,
  readBlob,
  SYNC_QUOTA_BYTES,
  unpackBackup,
} from './sync-blob.ts';
import { fitBackup } from './fit.ts';
import { encodeBackup, type Backup } from '../../../core/persist/backup-codec.ts';
import { backupFixture } from '../../../core/persist/backup.fixture.ts';
import { DEFAULT_PARAMS } from '../../../core/model/defaults.ts';
import { makeTrackIdentity } from '../../../core/model/track-identity.ts';
import type { ChordChart, HistoryEntry, TrackData } from '../../../core/model/types.ts';

const T0 = 1_757_000_000_000;

function chart(n: number): ChordChart {
  const labels = ['C', 'Am', 'F', 'G', 'Dm7', 'E7', 'Bm', 'D'];
  const segments = [];
  let t = 0.5;
  for (let i = 0; i < n; i++) {
    const d = 1.2 + ((i * 7) % 11) * 0.13;
    segments.push({ startT: t, endT: t + d, label: labels[(i * 5) % 8], confidence: 1 });
    t += d;
  }
  return { segments, key: { tonic: 'C', mode: 'major', confidence: 0.8 }, coverage: 1, analyzedFrom: 0, analyzedTo: t, computedAt: T0 };
}

/** `n` songs, each with a Recent row, a record with markers and a 160-segment
 * chart — random ids so gzip can't cheat on repetition. */
function library(n: number): Backup {
  const history: HistoryEntry[] = [];
  const tracks: TrackData[] = [];
  for (let i = 0; i < n; i++) {
    const vid = Math.random().toString(36).slice(2, 13);
    const id = makeTrackIdentity(`https://www.youtube.com/watch?v=${vid}`, `Artist ${i} - Song ${vid} (Official Video)`, 180 + i);
    history.push({
      identity: id,
      params: { ...DEFAULT_PARAMS, transpose: i % 3, speed: 0.75 },
      pageUrl: `https://www.youtube.com/watch?v=${vid}`,
      createdAt: T0,
      updatedAt: T0 + i * 60_000,
    });
    tracks.push({
      identity: id,
      markers: Array.from({ length: 6 }, (_, k) => ({ id: `m${k}`, t: k * 30 + Math.random(), label: `Part ${k}` })),
      snippets: [],
      sequenceLoop: false,
      sequenceCountIn: false,
      chordChart: chart(160),
      updatedAt: T0 + i * 60_000,
    });
  }
  return backupFixture({ history, tracks, appVersion: '1.0.3' });
}

test('base64 round-trips every byte value and a large buffer', () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(base64ToBytes(bytesToBase64(all)), all);
  const big = new Uint8Array(100_000).map(() => Math.floor(Math.random() * 256));
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
});

test('gzip round-trips text', async () => {
  const text = 'Note by Note '.repeat(1000) + '— ünïcödé';
  assert.equal(await gunzipToText(await gzipText(text)), text);
});

test('chunking and keys', () => {
  assert.deepEqual(chunkString('abcdefg', 3), ['abc', 'def', 'g']);
  assert.deepEqual(chunkString('', 3), []);
  assert.equal(chunkKey(0), 'nbn.0');
  assert.ok(isBlobKey('nbn.meta') && isBlobKey('nbn.10'));
  assert.ok(!isBlobKey('syncId') && !isBlobKey('nbn.x'));
});

test('pack → items → read → unpack round-trips within the per-item and total limits', async () => {
  const b = library(40);
  const { items, meta } = await packBackup(encodeBackup(b), '1.0.3');
  const chars = Object.entries(items)
    .filter(([key]) => key !== META_KEY)
    .reduce((n, [, chunk]) => n + (chunk as string).length, 0);
  assert.equal(meta.n, Math.ceil(chars / CHUNK_CHARS));
  assert.equal(meta.at, T0);
  for (const [key, value] of Object.entries(items)) {
    assert.ok(key.length + JSON.stringify(value).length <= 8192, `${key} too big`);
  }
  assert.ok(itemsBytes(items) <= SYNC_QUOTA_BYTES);
  const read = await readBlob(items);
  assert.equal(read.kind, 'ok');
  if (read.kind !== 'ok') return;
  const back = await unpackBackup(read.base64);
  assert.equal(back.history.length, 40);
  assert.equal(back.tracks[0].chordChart?.segments.length, 160);
  assert.deepEqual(encodeBackup(back), encodeBackup(b));
});

test('a 40-song library with charts is well inside the budget', async () => {
  const chars = await packedChars(encodeBackup(library(40)));
  assert.ok(chars < BUDGET_CHARS / 2, `${chars} of ${BUDGET_CHARS}`);
});

test('fit with the packed size as measure cuts a huge library to the budget', async () => {
  const b = library(1200);
  const measure = (x: Backup) => packedChars(encodeBackup(x));
  const result = await fitBackup(b, BUDGET_CHARS, measure);
  assert.equal(result.trimmed, true);
  assert.ok(result.size <= BUDGET_CHARS);
  const { meta } = await packBackup(encodeBackup(result.backup), '');
  assert.ok(meta.n <= MAX_CHUNKS);
  assert.ok(result.backup.history.length > 100, `kept ${result.backup.history.length}`);
});

test('torn and empty areas are told apart from a good blob', async () => {
  const { items } = await packBackup(encodeBackup(library(3)), '');
  assert.equal((await readBlob({})).kind, 'none');
  assert.equal((await readBlob({ syncId: 'legacy' })).kind, 'none');
  const missing = { ...items };
  delete missing[chunkKey(0)];
  assert.equal((await readBlob(missing)).kind, 'torn');
  const corrupt = { ...items, [chunkKey(0)]: 'AAAA' + (items[chunkKey(0)] as string).slice(4) };
  assert.equal((await readBlob(corrupt)).kind, 'torn');
  assert.equal((await readBlob({ [META_KEY]: 'junk' })).kind, 'torn');
  const extra = { ...items, [chunkKey(99)]: 'stale' };
  assert.equal((await readBlob(extra)).kind, 'ok');
});

test('a blob from a newer build is refused, not misread', async () => {
  const { items, meta } = await packBackup(encodeBackup(library(1)), '');
  await assert.rejects(readBlob({ ...items, [META_KEY]: { ...meta, v: meta.v + 1 } }), NewerVersionError);
});
