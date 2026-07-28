// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSegments,
  chordAt,
  estimateKey,
  keyFromSegments,
  PITCH_CLASS_NAMES,
} from './chord-decode.ts';
import type { ChordChart } from '../../../core/model/types.ts';

const FS = 0.0929;

test('buildSegments merges runs, drops N, breaks on gaps', () => {
  const frames = [];
  for (let i = 0; i < 30; i++) frames.push({ t: i * FS, label: 'C' });
  for (let i = 30; i < 40; i++) frames.push({ t: i * FS, label: 'N' }); // blank span
  for (let i = 40; i < 70; i++) frames.push({ t: i * FS, label: 'Am' });
  const segs = buildSegments(frames, FS);
  assert.deepEqual(segs.map((s) => s.label), ['C', 'Am']);
  assert.ok(segs[0].endT < segs[1].startT, 'gap left where the N span was');
});

test('buildSegments drops sub-minSegment flickers', () => {
  const frames = [
    { t: 0, label: 'C' },
    { t: FS, label: 'C' },
    { t: 2 * FS, label: 'G' }, // 1-frame flicker, < minSegment
    { t: 3 * FS, label: 'C' },
    { t: 4 * FS, label: 'C' },
    { t: 5 * FS, label: 'C' },
    { t: 6 * FS, label: 'C' },
    { t: 7 * FS, label: 'C' },
    { t: 8 * FS, label: 'C' },
  ];
  const segs = buildSegments(frames, FS, 0.5);
  assert.deepEqual(segs.map((s) => s.label), ['C']);
});

test('keyFromSegments recovers a I–IV–V–vi in C major', () => {
  const seg = (startT: number, endT: number, label: string) => ({
    startT, endT, label, confidence: 1,
  });
  const segments = [seg(0, 4, 'C'), seg(4, 8, 'F'), seg(8, 12, 'G'), seg(12, 16, 'Am')];
  const key = keyFromSegments(segments);
  assert.equal(key?.tonic, 'C');
  assert.equal(key?.mode, 'major');
});

test('estimateKey correlates the KK major profile to C major', () => {
  const kkMajor = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const key = estimateKey(kkMajor);
  assert.equal(key?.tonic, 'C');
  assert.equal(key?.mode, 'major');
  // Rotated to G.
  const g = new Array(12);
  for (let p = 0; p < 12; p++) g[p] = kkMajor[(p - PITCH_CLASS_NAMES.indexOf('G') + 12) % 12];
  assert.equal(estimateKey(g)?.tonic, 'G');
});

test('chordAt binary-searches the containing segment', () => {
  const chart: ChordChart = {
    segments: [
      { startT: 0, endT: 4, label: 'C', confidence: 1 },
      { startT: 4, endT: 6, label: 'G', confidence: 1 },
    ],
    key: null,
    coverage: 1,
    analyzedFrom: 0,
    analyzedTo: 6,
    computedAt: 0,
  };
  assert.equal(chordAt(chart, 3)?.label, 'C');
  assert.equal(chordAt(chart, 5)?.label, 'G');
  assert.equal(chordAt(chart, 8), null);
  assert.equal(chordAt(null, 1), null);
});
