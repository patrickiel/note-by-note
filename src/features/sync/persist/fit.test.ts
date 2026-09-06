// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FavoriteEntry, HistoryEntry, TrackData } from '../../../core/model/types.ts';
import { BACKUP_FORMAT, BACKUP_VERSION, type Backup } from '../../../core/persist/backup-format.ts';
import { buildSnapshot, fitSnapshot, fullPlan, SnapshotTooLargeError } from './fit.ts';
import type { SyncSnapshot } from './sync-snapshot.ts';

const META = { exportedAt: 1, appVersion: 't' };

function identity(key: string) {
  return { key, normalizedUrl: `https://x/${key}`, title: key, durationSec: 100 };
}

function chart(segments: number) {
  return {
    segments: Array.from({ length: segments }, (_, i) => ({
      startT: i * 2,
      endT: i * 2 + 2,
      label: 'C',
      confidence: 1,
    })),
    key: null,
    coverage: 1,
    analyzedFrom: 0,
    analyzedTo: segments * 2,
    computedAt: 1,
  };
}

function track(key: string, opts: { chart?: boolean; markers?: number; updatedAt?: number } = {}): TrackData {
  return {
    identity: identity(key),
    markers: Array.from({ length: opts.markers ?? 1 }, (_, i) => ({ id: `${key}${i}`, t: i, label: 'm' })),
    snippets: [],
    sequenceLoop: false,
    sequenceCountIn: false,
    chordChart: opts.chart ? chart(50) : null,
    updatedAt: opts.updatedAt ?? 1,
  };
}

function entry(key: string, updatedAt: number): HistoryEntry {
  return {
    identity: identity(key),
    params: {} as HistoryEntry['params'],
    pageUrl: `https://x/${key}`,
    createdAt: updatedAt,
    updatedAt,
  };
}

function favorite(key: string): FavoriteEntry {
  return { ...entry(key, 1), favoritedAt: 1, lastAccessedAt: 1 };
}

/** favorites f0..f2 (charts), history h0..h39 newest first (charts on even),
 * extras e0..e9 (charts on e0..e4), plus empty records that must vanish. */
function backup(): Backup {
  const favorites = ['f0', 'f1', 'f2'].map(favorite);
  const history = Array.from({ length: 40 }, (_, i) => entry(`h${i}`, 1000 - i));
  const tracks: TrackData[] = [
    ...favorites.map((f) => track(f.identity.key, { chart: true })),
    ...history.map((h, i) => track(h.identity.key, { chart: i % 2 === 0 })),
    ...Array.from({ length: 10 }, (_, i) => track(`e${i}`, { chart: i < 5, updatedAt: 100 - i })),
    track('empty0', { markers: 0 }),
    track('empty1', { markers: 0 }),
  ];
  // Storage order is arbitrary — shuffle deterministically.
  tracks.reverse();
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: 1,
    appVersion: 't',
    settings: {} as Backup['settings'],
    uiPrefs: {} as Backup['uiPrefs'],
    history,
    favorites,
    eqPresets: [],
    tracks,
    deletions: {},
  };
}

const sizeOf = async (s: SyncSnapshot) => ({ size: JSON.stringify(s).length, payload: null });
const keys = (s: SyncSnapshot) => s.tracks.map((t) => t.identity.key);
const chartKeys = (s: SyncSnapshot) => s.tracks.filter((t) => t.chart).map((t) => t.identity.key);

test('the full plan carries everything with content, favorites first, and no empty records', () => {
  const b = backup();
  const plan = fullPlan(b);
  assert.deepEqual(plan, { history: 40, extraTracks: 10, charts: 3 + 20 + 5 });
  const s = buildSnapshot(b, plan, META);
  assert.equal(s.trimmed, false);
  assert.deepEqual(keys(s).slice(0, 3), ['f0', 'f1', 'f2']);
  assert.deepEqual(keys(s).slice(3, 6), ['h0', 'h1', 'h2']);
  assert.deepEqual(keys(s).slice(43), ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
  assert.ok(!keys(s).some((k) => k.startsWith('empty')));
  assert.equal(chartKeys(s).length, 28);
  assert.equal(s.history.length, 40);
});

test('under budget nothing is trimmed', async () => {
  const b = backup();
  const full = await sizeOf(buildSnapshot(b, fullPlan(b), META));
  const fitted = await fitSnapshot(b, sizeOf, full.size, META);
  assert.equal(fitted.trimmed, false);
  assert.equal(fitted.size, full.size);
});

test('charts go first, favorites charts last among them; then extras; then history', async () => {
  const b = backup();
  const full = (await sizeOf(buildSnapshot(b, fullPlan(b), META))).size;
  const noCharts = (await sizeOf(buildSnapshot(b, { ...fullPlan(b), charts: 0 }, META))).size;

  // A budget between: some charts survive, and they are the favorites' ones.
  const mid = await fitSnapshot(b, sizeOf, (full + noCharts) / 2, META);
  assert.equal(mid.trimmed, true);
  assert.ok(mid.size <= (full + noCharts) / 2);
  assert.equal(mid.plan.history, 40);
  assert.equal(mid.plan.extraTracks, 10);
  assert.ok(mid.plan.charts > 0 && mid.plan.charts < 28);
  assert.deepEqual(chartKeys(mid.snapshot).slice(0, 3), ['f0', 'f1', 'f2']);

  // Just under "no charts": extras start to go, history is intact.
  const tight = await fitSnapshot(b, sizeOf, noCharts - 1, META);
  assert.equal(tight.plan.charts, 0);
  assert.ok(tight.plan.extraTracks < 10);
  assert.equal(tight.plan.history, 40);
  assert.ok(!keys(tight.snapshot).includes('e9'), 'oldest extra goes first');

  // Tighter still: history shrinks, the floor of 20 first.
  const noExtras = (await sizeOf(buildSnapshot(b, { history: 40, extraTracks: 0, charts: 0 }, META))).size;
  const trimmedHistory = await fitSnapshot(b, sizeOf, noExtras - 1, META);
  assert.equal(trimmedHistory.plan.extraTracks, 0);
  assert.ok(trimmedHistory.plan.history >= 20 && trimmedHistory.plan.history < 40);
  assert.equal(trimmedHistory.snapshot.history.length, trimmedHistory.plan.history);
  assert.equal(trimmedHistory.snapshot.history[0].identity.key, 'h0', 'newest kept');

  // Favorites and their records always travel.
  const t1 = (await sizeOf(buildSnapshot(b, { history: 0, extraTracks: 0, charts: 0 }, META))).size;
  const minimal = await fitSnapshot(b, sizeOf, t1, META);
  assert.deepEqual(keys(minimal.snapshot), ['f0', 'f1', 'f2']);
  assert.equal(minimal.snapshot.favorites.length, 3);
  await assert.rejects(fitSnapshot(b, sizeOf, t1 - 1, META), SnapshotTooLargeError);
});

test('the fit is the largest plan that fits (binary search reclaims the halving)', async () => {
  const b = backup();
  const at = async (charts: number) =>
    (await sizeOf(buildSnapshot(b, { ...fullPlan(b), charts }, META))).size;
  // Budget exactly fitting 20 charts must yield 20, not the halved 14.
  const fitted = await fitSnapshot(b, sizeOf, await at(20), META);
  assert.equal(fitted.plan.charts, 20);
});

test('deterministic for equal input', () => {
  const a = JSON.stringify(buildSnapshot(backup(), fullPlan(backup()), META));
  const c = JSON.stringify(buildSnapshot(backup(), fullPlan(backup()), META));
  assert.equal(a, c);
});
