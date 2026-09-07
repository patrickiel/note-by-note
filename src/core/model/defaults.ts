import type {
  ActionId,
  EffectParams,
  EqPreset,
  PanelId,
  Settings,
  UiPrefs,
} from './types';

/** ISO 10-band graphic EQ center frequencies (Hz). */
export const EQ_BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_GAIN_LIMIT = 12; // ±dB

/** Built-in curves that lean the mix toward one instrument's range, to play
 * along with. Gains are in EQ_BANDS order. Deliberately moderate: the bands are
 * octave-spaced at a fixed Q, so neighbours overlap and the combined response
 * overshoots the per-band numbers (see eq-response.ts). */
export const BUILTIN_EQ_PRESETS: EqPreset[] = [
  { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Bass', gains: [4, 6, 4, 0, -3, -5, -7, -8, -8, -8] },
  { name: 'Guitar', gains: [-8, -6, -1, 2, 4, 4, 3, 2, -3, -6] },
  { name: 'Vocals', gains: [-8, -7, -3, 1, 3, 4, 4, 3, -2, -5] },
  { name: 'Drums', gains: [3, 5, 1, 2, -3, -3, 2, 4, 5, 4] },
];

/** Transpose limits (± semitones). The standard one-octave range keeps the
 * slider precise for the common case; "Extended transpose range" in Settings
 * unlocks the full three octaves. */
export const TRANSPOSE_RANGE_STANDARD = 12;
export const TRANSPOSE_RANGE_EXTENDED = 36;
export const PITCH_CENTS_RANGE = 100;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 2;

/** Count-in bounds. Beats and BPM are user-configurable; these clamp bad
 * input (a stored NaN/0 would otherwise make the count-in never finish). */
export const COUNT_IN_BEATS_RANGE: [number, number] = [1, 16];
export const COUNT_IN_BPM_RANGE: [number, number] = [20, 400];

/** Count-in length: `beats` clicks one beat apart at `bpm`. */
export function countInDurationMs(beats: number, bpm: number): number {
  return (beats * 60000) / bpm;
}

export const HISTORY_LIMIT = 200;

export const DEFAULT_KEYMAP: Record<ActionId, string> = {
  playPause: 'Space',
  seekBack: 'ArrowLeft',
  seekFwd: 'ArrowRight',
  prevMarker: 'Shift+ArrowLeft',
  nextMarker: 'Shift+ArrowRight',
  jumpStart: 'Home',
  transposeUp: 'ArrowUp',
  transposeDown: 'ArrowDown',
  pitchUp: 'Shift+ArrowUp',
  pitchDown: 'Shift+ArrowDown',
  speedUp: '=',
  speedDown: '-',
  addMarker: 'm',
  toggleLoop: 'l',
  rangeSelect: 'r',
  addSnippet: 'c',
  // The obvious zoom keys are unavailable: -/= are speed, and Ctrl +/- is the
  // browser's own page zoom inside the side panel.
  zoomIn: 'z',
  zoomOut: 'Shift+z',
  zoomFit: '0',
  toggleFollow: 'f',
  power: 'p',
};

export const ACTION_LABELS: Record<ActionId, string> = {
  playPause: 'Play / pause',
  seekBack: 'Seek backward',
  seekFwd: 'Seek forward',
  prevMarker: 'Previous marker',
  nextMarker: 'Next marker',
  jumpStart: 'Jump to start',
  transposeUp: 'Transpose +1',
  transposeDown: 'Transpose −1',
  pitchUp: 'Pitch +1 cent',
  pitchDown: 'Pitch −1 cent',
  speedUp: 'Speed +5%',
  speedDown: 'Speed −5%',
  addMarker: 'Add marker',
  toggleLoop: 'Toggle loop',
  rangeSelect: 'Loop current section',
  addSnippet: 'Add snippet',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomFit: 'Zoom to fit / loop',
  toggleFollow: 'Auto-follow playhead',
  power: 'Power',
};

export const DEFAULT_PARAMS: EffectParams = {
  // Effect switches default on (unlike eq.enabled) so params saved before the
  // switches existed keep their audible behavior when restored.
  transpose: 0,
  transposeEnabled: true,
  pitchCents: 0,
  pitchEnabled: true,
  speed: 1,
  speedEnabled: true,
  vocalReduce: 0,
  vocalReduceEnabled: true,
  vocalMode: 'reduce',
  eq: { enabled: false, gains: EQ_BANDS.map(() => 0) },
  tuning: { trackHz: 440, instrumentHz: 440 },
  power: true,
  baseBpm: null,
};

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  pitchDisplay: 'cents',
  autoSave: true,
  autoReset: true,
  rememberSettings: false,
  seekInterval: 5,
  scrubPreviewMs: 500,
  lowLatency: false,
  formantPreserved: false,
  extendedTranspose: false,
  shortcutsEnabled: true,
  customShortcuts: false,
  keymap: { ...DEFAULT_KEYMAP },
  timeDisplayFormat: 'mm:ss.cc',
  tabAudio: false,
  countInBeats: 4,
  countInBpm: 100,
  countInBeep: true,
};

export const PANEL_ORDER: PanelId[] = [
  'transpose',
  'pitch',
  'speed',
  'vocalReducer',
  'equalizer',
];

export const PANEL_LABELS: Record<PanelId, string> = {
  transpose: 'Transpose',
  pitch: 'Pitch',
  speed: 'Speed',
  vocalReducer: 'Vocals',
  equalizer: 'Equalizer',
  chords: 'Chords',
};

export const DEFAULT_UI_PREFS: UiPrefs = {
  // First run opens focused: the playback effects (transpose/pitch/speed) are on
  // but their collapsible detail sections start closed, and effects stay off.
  collapsed: {
    transpose: true,
    pitch: true,
    speed: true,
    vocalReducer: true,
    equalizer: true,
    chords: true,
  },
  // Sections start expanded; the user folds them away as needed.
  collapsedSections: {
    playback: false,
    effects: false,
    tools: false,
    looper: false,
    snippets: false,
  },
  markerView: 'blocks',
  // On by default: follow does nothing until you zoom in, so this only means
  // the first zoom during playback doesn't lose the playhead off the edge.
  timelineFollow: true,
  favoritesSort: 'lastAccessed',
  libraryTab: 'recent',
  accentHue: 200,
  boundaryLabels: { start: '', end: '' },
};

export const SEEK_INTERVALS = [2, 5, 10, 15];
export const SCRUB_PREVIEW_OPTIONS = [200, 300, 500, 1000];

export function clampSpeed(speed: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}
