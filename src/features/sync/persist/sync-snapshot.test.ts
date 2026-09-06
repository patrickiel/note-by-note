// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChordChart, TrackData } from '../../../core/model/types.ts';
import { hasContent } from '../../../core/model/track-content.ts';
import { BACKUP_FORMAT } from '../../../core/persist/backup-format.ts';
import {
  decodeChart,
  decodeTrack,
  encodeChart,
  encodeTrack,
  NewerVersionError,
  parseSyncSnapshot,
  snapshotToBackup,
  SYNC_FORMAT_VERSION,
  type SyncSnapshot,
} from './sync-snapshot.ts';

/** BTC's frame grid — the raw times a real chart carries. */
const FRAME_SEC = 0.09287981859410431;

function frameChart(frames: number, confidence = 1): ChordChart {
  const labels = ['C', 'Am', 'F', 'G'];
  const segments = [];
  for (let i = 0; i < frames; i += 7) {
    segments.push({
      startT: i * FRAME_SEC,
      endT: Math.min(frames, i + 7) * FRAME_SEC,
      label: labels[(i / 7) % labels.length],
      confidence,
    });
  }
  return {
    segments,
    key: { tonic: 'C', mode: 'major', confidence: 0.8123456 },
    coverage: 0.987654,
    analyzedFrom: 0,
    analyzedTo: frames * FRAME_SEC,
    computedAt: 1_700_000_000_000,
  };
}

function track(key: string, partial: Partial<TrackData> = {}): TrackData {
  return {
    identity: { key, normalizedUrl: `https://x/${key}`, title: key, durationSec: 240 },
    markers: [],
    snippets: [],
    sequenceLoop: false,
    sequenceCountIn: false,
    chordChart: null,
    updatedAt: 1,
    ...partial,
  };
}

test('chart codec round-trips within half a centisecond, keeping order and labels', () => {
  const chart = frameChart(2600);
  const back = decodeChart(encodeChart(chart));
  assert.equal(back.segments.length, chart.segments.length);
  chart.segments.forEach((seg, i) => {
    assert.ok(Math.abs(back.segments[i].startT - seg.startT) <= 0.005);
    assert.ok(Math.abs(back.segments[i].endT - seg.endT) <= 0.005);
    assert.equal(back.segments[i].label, seg.label);
    assert.equal(back.segments[i].confidence, 1);
  });
  assert.ok(Math.abs(back.analyzedTo - chart.analyzedTo) <= 0.005);
  assert.equal(back.key?.confidence, 0.812);
  assert.equal(back.coverage, 0.988);
});

test('confidence travels only when it is not all ones', () => {
  assert.equal(encodeChart(frameChart(70)).c, undefined);
  const compact = encodeChart(frameChart(70, 0.54321));
  assert.deepEqual(compact.c, compact.l.map(() => 0.543));
  assert.equal(decodeChart(compact).segments[0].confidence, 0.543);
});

test('encoding is idempotent past the first pass', () => {
  const once = encodeChart(frameChart(2600, 0.7));
  const twice = encodeChart(decodeChart(once));
  assert.deepEqual(twice, once);
});

test('a compact chart is a fraction of the raw one', () => {
  const chart = frameChart(2600);
  const raw = JSON.stringify(chart).length;
  const compact = JSON.stringify(encodeChart(chart)).length;
  assert.ok(compact * 4 < raw, `${compact} vs ${raw}`);
});

test('decodeChart rejects mismatched arrays', () => {
  const compact = encodeChart(frameChart(70));
  assert.throws(() => decodeChart({ ...compact, d: compact.d.slice(1) }));
});

test('hasContent ignores flags and empty charts', () => {
  assert.equal(hasContent(track('a')), false);
  assert.equal(hasContent(track('a', { sequenceLoop: true, chordsEnabled: true })), false);
  assert.equal(
    hasContent(track('a', { chordChart: { ...frameChart(0), segments: [] } })),
    false,
  );
  assert.equal(hasContent(track('a', { markers: [{ id: 'm', t: 1, label: '' }] })), true);
  assert.equal(hasContent(track('a', { chordChart: frameChart(70) })), true);
});

test('track codec keeps markers and flags, and drops the chart on request', () => {
  const t = track('a', {
    markers: [{ id: 'm', t: 1.5, label: 'verse' }],
    chordChart: frameChart(70),
    chordsEnabled: true,
  });
  const withChart = decodeTrack(encodeTrack(t, true));
  assert.deepEqual(withChart.markers, t.markers);
  assert.equal(withChart.chordsEnabled, true);
  assert.equal(withChart.chordChart?.segments.length, 10);
  const without = encodeTrack(t, false);
  assert.equal(without.chart, undefined);
  assert.equal(decodeTrack(without).chordChart, null);
  const bare = decodeTrack(encodeTrack(track('b'), true));
  assert.equal('chordsEnabled' in bare, false);
});

test('snapshotToBackup yields the file shape and parseSyncSnapshot validates it back', () => {
  const snapshot: SyncSnapshot = {
    v: SYNC_FORMAT_VERSION,
    exportedAt: 5,
    appVersion: '1.2.3',
    settings: {} as SyncSnapshot['settings'],
    uiPrefs: {} as SyncSnapshot['uiPrefs'],
    history: [],
    favorites: [],
    eqPresets: [{ name: 'p', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    tracks: [encodeTrack(track('a', { chordChart: frameChart(70) }), true)],
    trimmed: true,
  };
  const backup = snapshotToBackup(snapshot);
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.tracks[0].chordChart?.segments.length, 10);
  const parsed = parseSyncSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(parsed, snapshot);
  assert.throws(() => parseSyncSnapshot({ ...snapshot, v: SYNC_FORMAT_VERSION + 1 }), NewerVersionError);
  assert.throws(() => parseSyncSnapshot({ ...snapshot, tracks: [{}] }));
  assert.throws(() => parseSyncSnapshot(null));
});
