// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_LIMIT } from '../../../core/model/defaults.ts';
import type { HistoryEntry, TrackData } from '../../../core/model/types.ts';
import {
  DELETION_CAP,
  DELETION_TTL_MS,
  HISTORY_CLEARED,
  mergeDeletions,
  normalizeDeletions,
  pruneDeletions,
} from '../../../core/persist/deletions.ts';
import { mergeHistory, mergeTracks } from './merge.ts';
import { encodeTrack } from './sync-snapshot.ts';

function entry(key: string, updatedAt: number): HistoryEntry {
  return {
    identity: { key, normalizedUrl: `https://x/${key}`, title: key, durationSec: 100 },
    params: {} as HistoryEntry['params'],
    pageUrl: `https://x/${key}`,
    createdAt: updatedAt,
    updatedAt,
  };
}

function track(key: string, updatedAt: number, chart = false): TrackData {
  return {
    identity: { key, normalizedUrl: `https://x/${key}`, title: key, durationSec: 100 },
    markers: [{ id: `${key}0`, t: 1, label: 'm' }],
    snippets: [],
    sequenceLoop: false,
    sequenceCountIn: false,
    chordChart: chart
      ? {
          segments: [{ startT: 0, endT: 1, label: 'C', confidence: 1 }],
          key: null,
          coverage: 1,
          analyzedFrom: 0,
          analyzedTo: 1,
          computedAt: 1,
        }
      : null,
    updatedAt,
  };
}

const keys = (list: { identity: { key: string } }[]) => list.map((e) => e.identity.key);

test('Recent trimmed by the sender survives a later snapshot that fits untrimmed', () => {
  // A had 200, pushed 118; B synced, changed a setting, pushed its 118 back.
  const a = Array.from({ length: 200 }, (_, i) => entry(`h${i}`, 1000 - i));
  assert.deepEqual(keys(mergeHistory(a.slice(0, 118), a, {}, {})), keys(a));
});

test('a removed row stays removed on both sides; one re-added later survives', () => {
  const a = [entry('x', 10), entry('y', 10)];
  const deletedY = { 'history:y': 20 };
  // B removed y and pushes without it.
  assert.deepEqual(keys(mergeHistory([entry('x', 10)], a, deletedY, {})), ['x']);
  // A removed y and receives B's list, which still carries the old copy.
  assert.deepEqual(keys(mergeHistory(a, [entry('x', 10)], {}, deletedY)), ['x']);
  // Edited after the deletion, from either side: a re-creation.
  assert.deepEqual(keys(mergeHistory([entry('y', 30)], [], {}, deletedY)), ['y']);
  assert.deepEqual(keys(mergeHistory([], [entry('y', 30)], deletedY, {})), ['y']);
});

test('"Clear Recent" propagates, rows added after it survive, and the list is newest first and capped', () => {
  const local = [entry('old', 5), entry('older', 3), entry('new', 50)];
  const merged = mergeHistory([entry('theirs', 40)], local, { [HISTORY_CLEARED]: 20 }, {});
  assert.deepEqual(keys(merged), ['new', 'theirs']);
  const many = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => entry(`h${i}`, i));
  assert.equal(mergeHistory(many.slice(0, 5), many, {}, {}).length, HISTORY_LIMIT);
});

test('deleting the last marker propagates; a record edited after the deletion wins', () => {
  const local = [track('t', 10)];
  const deletedT = { 'track:t': 20 };
  // The remote deleted it after our edit: ours goes.
  assert.deepEqual(mergeTracks([], local, deletedT, {}), []);
  // The remote merely left it out: ours stays.
  assert.deepEqual(keys(mergeTracks([], local, {}, {})), ['t']);
  // We deleted it; the remote's copy predates that and is not taken back.
  assert.deepEqual(mergeTracks([encodeTrack(track('t', 10), true)], [], {}, deletedT), []);
  // Edited after the deletion, from either side: a re-creation.
  assert.deepEqual(keys(mergeTracks([encodeTrack(track('t', 30), true)], [], {}, deletedT)), ['t']);
  assert.deepEqual(keys(mergeTracks([], [track('t', 30)], deletedT, {})), ['t']);
});

test('a stale remote copy of something deleted and re-created here does not shadow the re-creation', () => {
  // Deleted at 20, re-created at 30; the remote still holds the copy from 10.
  const h = mergeHistory([entry('y', 10)], [entry('y', 30)], {}, { 'history:y': 20 });
  assert.deepEqual(h.map((e) => e.updatedAt), [30]);
  const t = mergeTracks([encodeTrack(track('t', 10), true)], [track('t', 30)], {}, { 'track:t': 20 });
  assert.deepEqual(t.map((e) => e.updatedAt), [30]);
});

test('per key the newer copy wins, ties go to the remote', () => {
  const newerLocal = mergeHistory([entry('x', 10)], [entry('x', 20)], {}, {});
  assert.deepEqual(newerLocal.map((e) => e.updatedAt), [20]);
  const remoteTrack = encodeTrack(track('t', 10, true), true);
  const tie = mergeTracks([remoteTrack], [track('t', 10)], {}, {});
  assert.equal(tie[0].chordChart?.segments.length, 1, 'the remote copy, chart and all');
});

test('a remote record without a chart keeps the local chart', () => {
  const [kept] = mergeTracks([encodeTrack(track('t', 20), false)], [track('t', 10, true)], {}, {});
  assert.equal(kept.chordChart?.segments.length, 1);
  assert.equal(kept.updatedAt, 20);
});

test('deletion records merge by the later date, prune by age and count, normalize loosely', () => {
  assert.deepEqual(mergeDeletions({ a: 1, b: 5 }, { b: 2, c: 9 }), { a: 1, b: 5, c: 9 });

  const now = 10 * DELETION_TTL_MS;
  const d: Record<string, number> = { expired: now - DELETION_TTL_MS };
  for (let i = 0; i < DELETION_CAP + 20; i++) d[`k${i}`] = now - i;
  const pruned = pruneDeletions(d, now);
  assert.equal(Object.keys(pruned).length, DELETION_CAP);
  assert.equal('expired' in pruned, false);
  assert.equal('k0' in pruned, true);
  assert.equal(`k${DELETION_CAP}` in pruned, false);

  assert.deepEqual(normalizeDeletions(undefined), {});
  assert.deepEqual(normalizeDeletions({ a: 1, b: 'x', c: Infinity }), { a: 1 });
});
