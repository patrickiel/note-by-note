import type {
  ChordChart,
  ChordSegment,
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  KeySignature,
  Marker,
  Settings,
  Snippet,
  TrackData,
  TrackIdentity,
  UiPrefs,
} from '../../../core/model/types.ts';
import { hasChart, hasContent } from '../../../core/model/track-content.ts';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  isRecord,
  requireArray,
  requireKeyedArray,
  type Backup,
} from '../../../core/persist/backup-format.ts';

/**
 * The snapshot that travels through `browser.storage.sync` — the backup with
 * its per-track records in a compact form, so a whole library fits the
 * browser's 100 KB sync quota after gzip (see `fit.ts` for what gets trimmed
 * when it still doesn't).
 *
 * Pure and DOM-free: runs under `node --test`. Relative `.ts` imports for that
 * reason — see CLAUDE.md.
 */

/** Bump only for changes older builds can't read; `parseSyncSnapshot` rejects
 * anything newer so an old device never applies a snapshot it misreads. */
export const SYNC_FORMAT_VERSION = 2 as const;

/** A chord chart with its times on a centisecond grid and its per-segment
 * records unzipped into parallel arrays. The raw chart carries 17-digit
 * frame-grid floats and repeats four keys per segment — ~90 bytes each; this
 * is ~12, and the delta-coded starts gzip well on top. */
export interface CompactChordChart {
  /** Segment starts, centiseconds, delta-coded (`t[0]` is absolute). */
  t: number[];
  /** Segment durations, centiseconds. */
  d: number[];
  /** Segment labels. */
  l: string[];
  /** Per-segment confidence (3 dp). Omitted when every segment's is 1 — which
   * is what the detector emits today (see chords/panel/chord-decode.ts). */
  c?: number[];
  key: KeySignature | null;
  coverage: number;
  /** Centiseconds. */
  analyzedFrom: number;
  /** Centiseconds. */
  analyzedTo: number;
  computedAt: number;
}

/** `TrackData` as synced. A missing `chart` means "none here" *or* "trimmed
 * by the budget" — the receiver cannot tell and must not care (see
 * `apply.ts`, which keeps its own chart in that case). */
export interface CompactTrackData {
  identity: TrackIdentity;
  markers: Marker[];
  snippets: Snippet[];
  sequenceLoop: boolean;
  sequenceCountIn: boolean;
  chordsEnabled?: boolean;
  updatedAt: number;
  chart?: CompactChordChart;
}

export interface SyncSnapshot {
  v: typeof SYNC_FORMAT_VERSION;
  /** Wall clock of the device that wrote it — the last-write-wins clock. */
  exportedAt: number;
  appVersion: string;
  settings: Settings;
  uiPrefs: UiPrefs;
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  eqPresets: EqPreset[];
  tracks: CompactTrackData[];
  /** The writer had to leave something out to fit the quota. */
  trimmed: boolean;
}

/** Thrown when a snapshot (or blob) was written by a build newer than this
 * one; the store shows it rather than applying data it can't read. */
export class NewerVersionError extends Error {
  constructor() {
    super('Synced data was written by a newer version of Note by Note.');
    this.name = 'NewerVersionError';
  }
}

export { hasChart, hasContent };

const centis = (seconds: number) => Math.round(seconds * 100);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function compactKey(key: KeySignature | null): KeySignature | null {
  return key ? { tonic: key.tonic, mode: key.mode, confidence: round3(key.confidence) } : null;
}

/** Idempotent past the first pass: `encode(decode(encode(x)))` equals
 * `encode(x)`, which is what lets two devices compare content hashes of
 * snapshots that both went through this. */
export function encodeChart(chart: ChordChart): CompactChordChart {
  const segments = [...chart.segments].sort((a, b) => a.startT - b.startT);
  const t: number[] = [];
  const d: number[] = [];
  const l: string[] = [];
  const c: number[] = [];
  let allOne = true;
  let prev = 0;
  for (const seg of segments) {
    const start = centis(seg.startT);
    const end = centis(seg.endT);
    t.push(start - prev);
    prev = start;
    d.push(Math.max(0, end - start));
    l.push(seg.label);
    const confidence = round3(seg.confidence);
    c.push(confidence);
    if (confidence !== 1) allOne = false;
  }
  const out: CompactChordChart = {
    t,
    d,
    l,
    key: compactKey(chart.key),
    coverage: round3(chart.coverage),
    analyzedFrom: centis(chart.analyzedFrom),
    analyzedTo: centis(chart.analyzedTo),
    computedAt: chart.computedAt,
  };
  if (!allOne) out.c = c;
  return out;
}

export function decodeChart(compact: CompactChordChart): ChordChart {
  const { t, d, l, c } = compact;
  if (t.length !== d.length || t.length !== l.length || (c !== undefined && c.length !== t.length)) {
    throw new Error('Synced chord chart is damaged.');
  }
  const segments: ChordSegment[] = [];
  let acc = 0;
  for (let i = 0; i < t.length; i++) {
    acc += t[i];
    segments.push({
      startT: acc / 100,
      endT: (acc + d[i]) / 100,
      label: l[i],
      confidence: c?.[i] ?? 1,
    });
  }
  return {
    segments,
    key: compact.key,
    coverage: compact.coverage,
    analyzedFrom: compact.analyzedFrom / 100,
    analyzedTo: compact.analyzedTo / 100,
    computedAt: compact.computedAt,
  };
}

export function encodeTrack(track: TrackData, withChart: boolean): CompactTrackData {
  const out: CompactTrackData = {
    identity: track.identity,
    markers: track.markers,
    snippets: track.snippets,
    sequenceLoop: track.sequenceLoop,
    sequenceCountIn: track.sequenceCountIn,
    updatedAt: track.updatedAt,
  };
  if (track.chordsEnabled !== undefined) out.chordsEnabled = track.chordsEnabled;
  if (withChart && track.chordChart && hasChart(track)) out.chart = encodeChart(track.chordChart);
  return out;
}

export function decodeTrack(track: CompactTrackData): TrackData {
  const out: TrackData = {
    identity: track.identity,
    markers: track.markers,
    snippets: track.snippets,
    sequenceLoop: track.sequenceLoop,
    sequenceCountIn: track.sequenceCountIn,
    chordChart: track.chart ? decodeChart(track.chart) : null,
    updatedAt: track.updatedAt,
  };
  if (track.chordsEnabled !== undefined) out.chordsEnabled = track.chordsEnabled;
  return out;
}

/** The file shape of a synced snapshot, so `snapshotHash` and the backup
 * validation apply to it unchanged. No default backfill here — that is
 * `normalizeBackup`'s job at apply time. */
export function snapshotToBackup(snapshot: SyncSnapshot): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: snapshot.exportedAt,
    appVersion: snapshot.appVersion,
    settings: snapshot.settings,
    uiPrefs: snapshot.uiPrefs,
    history: snapshot.history,
    favorites: snapshot.favorites,
    eqPresets: snapshot.eqPresets,
    tracks: snapshot.tracks.map(decodeTrack),
  };
}

function normalizeTrack(raw: CompactTrackData): CompactTrackData {
  const out: CompactTrackData = {
    identity: raw.identity,
    markers: Array.isArray(raw.markers) ? raw.markers : [],
    snippets: Array.isArray(raw.snippets) ? raw.snippets : [],
    sequenceLoop: raw.sequenceLoop === true,
    sequenceCountIn: raw.sequenceCountIn === true,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
  if (typeof raw.chordsEnabled === 'boolean') out.chordsEnabled = raw.chordsEnabled;
  if (isRecord(raw.chart)) {
    const chart = raw.chart as unknown as CompactChordChart;
    if (!Array.isArray(chart.t) || !Array.isArray(chart.d) || !Array.isArray(chart.l)) {
      throw new Error('Synced chord chart is damaged.');
    }
    out.chart = chart;
  }
  return out;
}

/** Validates a decoded blob into a `SyncSnapshot`, or throws an `Error` whose
 * message is safe to show. Structural checks only — defaults are backfilled
 * by `normalizeBackup` when the snapshot is applied. */
export function parseSyncSnapshot(raw: unknown): SyncSnapshot {
  if (!isRecord(raw) || typeof raw.v !== 'number') {
    throw new Error('Synced data is damaged.');
  }
  if (raw.v > SYNC_FORMAT_VERSION) throw new NewerVersionError();
  return {
    v: SYNC_FORMAT_VERSION,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    // Partial objects are fine here: `normalizeBackup` backfills the defaults
    // when the snapshot is applied.
    settings: (isRecord(raw.settings) ? raw.settings : {}) as unknown as Settings,
    uiPrefs: (isRecord(raw.uiPrefs) ? raw.uiPrefs : {}) as unknown as UiPrefs,
    history: requireKeyedArray<HistoryEntry>(raw.history, 'history'),
    favorites: requireKeyedArray<FavoriteEntry>(raw.favorites, 'favorites'),
    eqPresets: requireArray(raw.eqPresets, 'eqPresets') as EqPreset[],
    tracks: requireKeyedArray<CompactTrackData>(raw.tracks, 'tracks').map(normalizeTrack),
    trimmed: raw.trimmed === true,
  };
}
