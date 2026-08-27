/** Automatic reference-tuning (A4) detection from a live AnalyserNode.
 *
 * Approach: take a handful of long, high-resolution magnitude spectra and
 * score every candidate tuning offset (−50…+49 cents around 440 Hz) with a
 * "tuning comb": the sum of spectral energy sitting exactly on the equal-
 * tempered pitch grid shifted by that offset. Real notes (and their octave
 * partials) all share the recording's offset, so the comb score peaks at the
 * true tuning — A4 = 440 · 2^(cents/1200). Energy is measured as prominence
 * above a local running floor, so dense mixes, rumble and broadband noise
 * contribute little.
 *
 * The offset is folded to ±50 ¢, so the answer is ambiguous by a semitone (a
 * 415 Hz baroque recording reads as 440). That is fine here: transposition is
 * a separate control; tuning only covers the ±50-cent window.
 *
 * Calibration (real pop/rock captures + synthetic controls, see git history):
 * white/brown noise, noise bursts and a pitch glide score a `confidence` of
 * 0.06–0.12; music scores 0.11–0.57, and the two tracks under 0.15 were the
 * ones whose split-half estimates disagreed (percussion-dominated). Hence the
 * 0.15 default gate.
 *
 * The estimator core (`estimateTuningFromSpectra`) is pure, DOM-free and
 * dependency-free so it runs under `node --test` (see detect-tuning.test.ts).
 * Only `detectTuningFromAnalyser` touches Web Audio.
 */

export interface TuningEstimate {
  /** Measured A4 in Hz (rounded), or null when the audio is silent/unpitched. */
  hz: number | null;
  /** Prominence of the winning comb score over the mean score, 0–1. */
  confidence: number;
  /** Diagnostics for logging — every number that went into the decision. */
  details: TuningDetails;
}

export interface TuningDetails {
  /** Spectra received / spectra loud enough to be scored. */
  frames: number;
  usedFrames: number;
  /** Winning offset from 440-based ET, in cents (sub-cent refined). */
  devCents: number;
  /** Raw winning bin before refinement, in cents. */
  peakCents: number;
  /** Comb score at the winner, the mean over all offsets, and the best score
   * more than 5 ¢ away from the winner (the runner-up hypothesis). */
  peakScore: number;
  meanScore: number;
  runnerUpScore: number;
  runnerUpCents: number;
  /** Whether the confidence cleared `minConfidence`. */
  accepted: boolean;
}

export interface TuningOptions {
  /** Lowest grid frequency scored (below: rumble, coarse cents resolution). */
  minHz?: number;
  /** Highest grid frequency scored. */
  maxHz?: number;
  /** Below this confidence the result is treated as no-tuning. */
  minConfidence?: number;
  /** Fewer scored (non-silent) frames than this → no-tuning: a comb over one
   * or two windows of noise can fluke a plausible confidence. */
  minFrames?: number;
}

const DEFAULTS: Required<TuningOptions> = {
  minHz: 100,
  maxHz: 2000,
  minConfidence: 0.15,
  minFrames: 3,
};

/** Frames whose loudest bin in range sits below this are treated as silence. */
const SILENCE_DB = -80;
/** Offsets scored: one per cent over the ±50 ¢ fold. */
const BINS = 100;
/** Half-width (bins) of the running-mean floor each bin's prominence is
 * measured against. ~60 bins ≈ 80 Hz at 44.1 kHz/32768 — wide enough to
 * sit under a peak's Blackman main lobe, narrow enough to track the mix's
 * spectral tilt. */
const FLOOR_HALF_WIDTH = 60;
/** MIDI note range of the comb (A0 … B7). */
const MIDI_LO = 21;
const MIDI_HI = 107;

function emptyDetails(frames: number): TuningDetails {
  return {
    frames,
    usedFrames: 0,
    devCents: 0,
    peakCents: 0,
    peakScore: 0,
    meanScore: 0,
    runnerUpScore: 0,
    runnerUpCents: 0,
    accepted: false,
  };
}

/** Estimate the reference A4 from dB-magnitude spectra (`getFloatFrequencyData`
 * layout: bin k ↔ k · sampleRate / fftSize). */
export function estimateTuningFromSpectra(
  spectra: Float32Array[],
  sampleRate: number,
  fftSize: number,
  opts: TuningOptions = {},
): TuningEstimate {
  const { minHz, maxHz, minConfidence, minFrames } = { ...DEFAULTS, ...opts };
  const binHz = sampleRate / fftSize;
  const score = new Float64Array(BINS);
  const details = emptyDetails(spectra.length);

  // Grid frequencies per offset, computed once.
  const grid: number[][] = [];
  for (let c = 0; c < BINS; c++) {
    const row: number[] = [];
    for (let n = MIDI_LO; n <= MIDI_HI; n++) {
      const f = 440 * 2 ** ((n - 69) / 12 + (c - 50) / 1200);
      if (f >= minHz && f <= maxHz) row.push(f);
    }
    grid.push(row);
  }

  for (const mag of spectra) {
    const kLo = Math.max(1, Math.floor(minHz / binHz));
    const kHi = Math.min(mag.length - 2, Math.ceil(maxHz / binHz));
    if (kHi <= kLo) continue;
    let loudest = -Infinity;
    for (let k = kLo; k <= kHi; k++) if (mag[k] > loudest) loudest = mag[k];
    if (!(loudest > SILENCE_DB)) continue;
    details.usedFrames++;

    // Prominence above the local running mean, as linear magnitude.
    const prefix = new Float64Array(mag.length + 1);
    for (let k = 0; k < mag.length; k++) {
      // −Infinity (digital silence) would poison the sums; clamp.
      prefix[k + 1] = prefix[k] + Math.max(mag[k], -200);
    }
    const w = new Float32Array(kHi + 2);
    for (let k = kLo; k <= kHi; k++) {
      const a = Math.max(0, k - FLOOR_HALF_WIDTH);
      const b = Math.min(mag.length, k + FLOOR_HALF_WIDTH + 1);
      const floor = (prefix[b] - prefix[a]) / (b - a);
      const d = mag[k] - floor;
      w[k] = d > 0 ? 10 ** (d / 20) - 1 : 0;
    }

    for (let c = 0; c < BINS; c++) {
      let s = 0;
      for (const f of grid[c]) {
        const x = f / binHz;
        const k = Math.floor(x);
        if (k < kLo || k + 1 > kHi) continue;
        const frac = x - k;
        s += w[k] * (1 - frac) + w[k + 1] * frac;
      }
      score[c] += s;
    }
  }

  if (details.usedFrames === 0) return { hz: null, confidence: 0, details };

  let best = 0;
  let mean = 0;
  for (let c = 0; c < BINS; c++) {
    if (score[c] > score[best]) best = c;
    mean += score[c];
  }
  mean /= BINS;
  const peak = score[best];
  if (peak <= 0) return { hz: null, confidence: 0, details };

  let runnerUp = 0;
  let runnerUpBin = best;
  for (let c = 0; c < BINS; c++) {
    const dist = Math.min(Math.abs(c - best), BINS - Math.abs(c - best));
    if (dist > 5 && score[c] > runnerUp) {
      runnerUp = score[c];
      runnerUpBin = c;
    }
  }

  // Circular parabolic refinement around the winning offset.
  const a = score[(best - 1 + BINS) % BINS];
  const b = peak;
  const cc = score[(best + 1) % BINS];
  const denom = a - 2 * b + cc;
  const delta = denom === 0 ? 0 : (0.5 * (a - cc)) / denom;
  const devCents = best - 50 + delta;

  const confidence = (peak - mean) / peak;
  const accepted = confidence >= minConfidence && details.usedFrames >= minFrames;
  Object.assign(details, {
    devCents,
    peakCents: best - 50,
    peakScore: peak,
    meanScore: mean,
    runnerUpScore: runnerUp,
    runnerUpCents: runnerUpBin - 50,
    accepted,
  });
  return {
    hz: accepted ? Math.round(440 * 2 ** (devCents / 1200)) : null,
    confidence,
    details,
  };
}

export interface CollectOptions {
  /** How long to listen, in ms. */
  durationMs?: number;
}

/** Long window → ~1.5 Hz bins at 48 kHz; the parabolic refinement gets well
 * under a cent at A4 from that. (32768 is the AnalyserNode maximum.) */
export const TUNING_FFT_SIZE = 32768;

/**
 * Listen to the audio flowing through `tap` for `durationMs` and estimate
 * its reference A4. `tap` is the pipeline's raw-source analyser: it sits
 * before the stretch worklet and the element plays with `preservesPitch`, so
 * what it hears is the recording's own pitch regardless of speed/transpose.
 * A private high-resolution analyser is chained off it for the duration.
 */
export async function detectTuningFromAnalyser(
  tap: AnalyserNode,
  opts: TuningOptions & CollectOptions = {},
  shouldAbort?: () => boolean,
): Promise<TuningEstimate> {
  const { durationMs = 4000, ...tuningOpts } = opts;
  const ctx = tap.context;
  const hires = ctx.createAnalyser();
  hires.fftSize = TUNING_FFT_SIZE;
  hires.smoothingTimeConstant = 0;
  tap.connect(hires);
  const spectra: Float32Array[] = [];
  try {
    const buf = new Float32Array(hires.frequencyBinCount);
    // One spectrum per half-window so consecutive frames see mostly new audio.
    const frameMs = ((TUNING_FFT_SIZE / ctx.sampleRate) * 1000) / 2;
    // Timer-driven, not requestAnimationFrame: rAF stops entirely while the
    // tab is hidden or the window occluded, and the sampling cadence here is
    // loose enough that background-tab timer throttling (≥1 s) still yields
    // a few usable frames within the window.
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        if (shouldAbort?.()) {
          resolve();
          return;
        }
        hires.getFloatFrequencyData(buf);
        spectra.push(buf.slice());
        if (performance.now() - t0 >= durationMs) {
          resolve();
          return;
        }
        setTimeout(tick, frameMs);
      };
      // The first frame waits for the analyser to fill its window.
      setTimeout(tick, frameMs);
    });
  } finally {
    tap.disconnect(hires);
  }
  return estimateTuningFromSpectra(spectra, ctx.sampleRate, TUNING_FFT_SIZE, tuningOpts);
}
