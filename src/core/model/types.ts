/** Real-time effect parameters. The engine (content script / offscreen / local
 * player) is the source of truth; the UI sends patches and mirrors echoes. */
export interface EffectParams {
  /** Semitones, ±12 (±36 with Extended range). */
  transpose: number;
  /** false = transpose bypassed (per-panel switch). */
  transposeEnabled: boolean;
  /** Fine tune in cents, ±100. */
  pitchCents: number;
  /** false = pitch fine-tune and reference tuning bypassed (per-panel switch). */
  pitchEnabled: boolean;
  /** Playback rate, 0.25–2.0 (UI shows percent). */
  speed: number;
  /** false = speed bypassed (per-panel switch). */
  speedEnabled: boolean;
  /** Vocal reducer amount 0–1 (strength in both modes). */
  vocalReduce: number;
  /** false = vocal reducer bypassed (per-panel switch). */
  vocalReduceEnabled: boolean;
  /** 'reduce' drops the center vocal (karaoke), 'isolate' keeps it and drops
   * the backing. Both use the same amount slider. */
  vocalMode: 'reduce' | 'isolate';
  eq: { enabled: boolean; gains: number[] };
  /** Reference tuning: recording's and instrument's A4 in Hz. */
  tuning: { trackHz: number; instrumentHz: number };
  /** false = processing bypass (Power toggle). */
  power: boolean;
  /** User-entered base tempo; effective bpm = baseBpm × speed. Display only.
   * null = unset. Not `undefined`: patches are JSON-serialized over the port,
   * which drops undefined-valued keys, so clearing would never reach the
   * engine and its echo would restore the stale value. */
  baseBpm: number | null;
}

/** A named EQ curve, either built in or saved by the user. `gains` holds one
 * dB value per EQ_BANDS band, in band order. */
export interface EqPreset {
  name: string;
  gains: number[];
}

export interface Marker {
  id: string;
  /** Position in seconds. Displayed numbering is the sort order by t. */
  t: number;
  label: string;
}

/** Effect settings a snippet may override while it plays. */
export type SnippetOverrides = Partial<
  Pick<EffectParams, 'speed' | 'transpose' | 'vocalReduce'>
>;

export interface Snippet {
  id: string;
  name: string;
  startT: number;
  endT: number;
  /** Off = skipped by the sequence without deleting. */
  enabled: boolean;
  /** How many times the snippet loops before the sequence moves on. */
  repeats: number;
  overrides: SnippetOverrides;
}

/** One detected chord spanning [startT, endT) seconds. */
export interface ChordSegment {
  startT: number;
  endT: number;
  /** Display label, e.g. "C", "Am", "F#". */
  label: string;
  /** Match confidence 0–1 (mean template similarity across the segment). */
  confidence: number;
}

/** Detected musical key of a track. */
export interface KeySignature {
  /** Tonic pitch-class name, e.g. "C", "F#". */
  tonic: string;
  mode: 'major' | 'minor';
  /** Key-profile correlation strength 0–1. */
  confidence: number;
}

/** Whole-song chord chart, built up while chord detection runs and cached
 * per-track so re-opening a song shows it instantly. */
export interface ChordChart {
  segments: ChordSegment[];
  key: KeySignature | null;
  /** Fraction of the track duration analyzed so far (0–1). */
  coverage: number;
  /** Analyzed media-time bounds (seconds); spans outside [from,to] render as
   * "not detected yet" placeholders. */
  analyzedFrom: number;
  analyzedTo: number;
  computedAt: number;
}

/** Stable identity of a piece of media, so settings/markers/snippets survive
 * reloads and URL noise. */
export interface TrackIdentity {
  /** `${hash(normalizedUrl)}:${round(duration)}` */
  key: string;
  normalizedUrl: string;
  title: string;
  durationSec: number;
}

/** Per-track saved data (markers, snippets) — persists independent of history. */
export interface TrackData {
  identity: TrackIdentity;
  markers: Marker[];
  snippets: Snippet[];
  /** Repeat the whole snippet sequence. */
  sequenceLoop: boolean;
  /** Count in on play and before each snippet repeat lap (not on section loop). */
  sequenceCountIn: boolean;
  /** Cached chord/key chart from the last analysis run. null = never analyzed.
   * (null, not undefined — patches serialize over the port, dropping undefined.) */
  chordChart?: ChordChart | null;
  /** Chords panel switch. Kept apart from the chart so switching off hides the
   * panel without discarding the analysis. Undefined on pre-switch records. */
  chordsEnabled?: boolean;
  updatedAt: number;
}

/** A "Recent" history entry (Auto Save). */
export interface HistoryEntry {
  identity: TrackIdentity;
  params: EffectParams;
  thumbnailUrl?: string;
  pageUrl: string;
  createdAt: number;
  updatedAt: number;
}

/** A song the user starred (History → Favorites). Persists independently of
 * the LRU-capped Recent list. Stored array order = manual sort order. */
export interface FavoriteEntry extends HistoryEntry {
  favoritedAt: number;
  /** Last time the track was opened or played, for "Last Accessed" sorting. */
  lastAccessedAt: number;
}

export type FavoritesSort = 'lastAccessed' | 'title' | 'manual';

export type ConnectionState =
  /** Pages the extension cannot run on (chrome://, Web Store …). */
  | 'restricted'
  /** No host permission granted / content script not injected yet. */
  | 'idle'
  | 'detecting'
  /** Media element found but not playing → "Start playback". */
  | 'media-paused'
  | 'connected-direct'
  /** Element transport works, pitch runs through tab capture. */
  | 'connected-hybrid'
  /** All audio through tab capture; pitch shift only. */
  | 'connected-capture'
  /** Audio detected but processor can't attach → "Pitch not available". */
  | 'pitch-unavailable'
  /** Tab is audible but no media element found → "No compatible player". */
  | 'no-player'
  | 'local-file'
  /** Connection went stale (navigation/reload) → "Start playback" + hint. */
  | 'stale';

export type LoopMode =
  | { kind: 'range'; startT: number; endT: number }
  | { kind: 'song' };

export interface LoopState {
  mode: LoopMode | null;
  active: boolean;
  countIn: boolean;
  /** Current lap number while looping (1-based). */
  lap: number;
}

/** Runtime shape the sequence scheduler consumes (enabled snippets only, in order). */
export interface SnippetRuntime {
  id: string;
  name: string;
  startT: number;
  endT: number;
  repeats: number;
  countIn: boolean;
  overrides: SnippetOverrides;
}

export interface SequenceState {
  running: boolean;
  activeSnippetId: string | null;
  lap: number;
  totalLaps: number;
  loopAll: boolean;
}

/** Live count-in progress broadcast to the panel (loop restart, snippet lap, or
 * manual play). `beat` is 1-based and counts up to `beats`. */
export interface CountInProgress {
  /** Milliseconds left until playback resumes. */
  remainingMs: number;
  /** Current beat being counted (1..beats). */
  beat: number;
  /** Total beats in the count-in. */
  beats: number;
}

export interface MediaInfo {
  title: string;
  pageUrl: string;
  duration: number;
  hasVideo: boolean;
  thumbnailUrl?: string;
}

export type PitchDisplay = 'cents' | 'hz';
export type Theme = 'auto' | 'light' | 'dark';
export type TimeDisplayFormat = 'mm:ss.cc' | 'hh:mm:ss' | 'seconds' | 'remaining';
export type MarkerView = 'blocks' | 'list';

export type ActionId =
  | 'playPause'
  | 'seekBack'
  | 'seekFwd'
  | 'prevMarker'
  | 'nextMarker'
  | 'jumpStart'
  | 'transposeUp'
  | 'transposeDown'
  | 'pitchUp'
  | 'pitchDown'
  | 'speedUp'
  | 'speedDown'
  | 'addMarker'
  | 'toggleLoop'
  | 'rangeSelect'
  | 'addSnippet'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'toggleFollow'
  | 'power';

/** User preferences. Persisted in storage.local. */
export interface Settings {
  theme: Theme;
  pitchDisplay: PitchDisplay;
  autoSave: boolean;
  autoReset: boolean;
  rememberSettings: boolean;
  seekInterval: number;
  scrubPreviewMs: number;
  lowLatency: boolean;
  /** Preserve the formant envelope while pitch-shifting ("Natural vocals"). */
  formantPreserved: boolean;
  /** Extend the Transpose control to ±36 semitones (three octaves); off = ±12. */
  extendedTranspose: boolean;
  shortcutsEnabled: boolean;
  customShortcuts: boolean;
  keymap: Record<ActionId, string>;
  timeDisplayFormat: TimeDisplayFormat;
  tabAudio: boolean;
  /** Count-in: number of beats to count before playback resumes. */
  countInBeats: number;
  /** Count-in tempo in BPM (fixed; one click per beat). */
  countInBpm: number;
  /** Play an audible click on each count-in beat (accented downbeat). */
  countInBeep: boolean;
  lastUsedParams?: EffectParams;
}

export type PanelId =
  | 'transpose'
  | 'pitch'
  | 'speed'
  | 'vocalReducer'
  | 'equalizer'
  | 'chords';

/** The collapsible workspace sections (Playback / Effects / Tools / Looper / Snippets). */
export type SectionId = 'playback' | 'effects' | 'tools' | 'looper' | 'snippets';

/** Cosmetic UI state, persisted separately from Settings. */
export interface UiPrefs {
  collapsed: Record<PanelId, boolean>;
  collapsedSections: Record<SectionId, boolean>;
  markerView: MarkerView;
  /** Page the zoomed timeline forward when the playhead leaves the visible
   * window. Inert at full-track view, where the playhead is always on screen. */
  timelineFollow: boolean;
  favoritesSort: FavoritesSort;
  libraryTab: 'recent' | 'favorites';
  /** Accent hue in HSL degrees (0–360), driving the themed accent colors. */
  accentHue: number;
  /** User overrides for the virtual Start/End marker labels (empty = default). */
  boundaryLabels: { start: string; end: string };
}
