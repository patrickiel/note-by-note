/** Automatic tempo (BPM) detection from a live AnalyserNode.
 *
 * Approach: poll the analyser's raw time-domain window, build a
 * log-compressed spectral-flux onset envelope, resample it onto a uniform
 * grid, then estimate tempo by prior-weighted autocorrelation with an
 * octave-comb disambiguation pass.
 *
 * The estimator core (`estimateTempoFromEnvelope`, `resampleUniform`) is pure,
 * DOM-free and dependency-free so it runs under `node --test`
 * (see detect-bpm.test.ts). Only `detectBpmFromAnalyser` touches Web Audio.
 */

import { ComplexFft, makeHannWindow } from '../../../core/audio/fft.ts';

export interface BpmEstimate {
  /** Measured tempo in BPM, or null when the audio is silent/non-rhythmic. */
  bpm: number | null;
  /** Normalized autocorrelation height at the chosen lag (0–1). */
  confidence: number;
}

export interface TempoOptions {
  /** Slowest tempo considered. */
  minBpm?: number;
  /** Fastest tempo considered. */
  maxBpm?: number;
  /** Center of the log-Gaussian tempo prior. */
  preferBpm?: number;
  /** Prior width (sigma) in log2 space (~1 octave). */
  preferWidth?: number;
  /** Below this autocorrelation height the result is treated as no-tempo. */
  minConfidence?: number;
}

const DEFAULTS: Required<TempoOptions> = {
  minBpm: 50,
  maxBpm: 210,
  preferBpm: 120,
  preferWidth: 0.9,
  minConfidence: 0.15,
};

/** Estimate tempo from a uniformly-sampled onset-novelty envelope. */
export function estimateTempoFromEnvelope(
  env: Float32Array,
  rate: number,
  opts: TempoOptions = {},
): BpmEstimate {
  const { minBpm, maxBpm, preferBpm, preferWidth, minConfidence } = {
    ...DEFAULTS,
    ...opts,
  };
  const n = env.length;
  // Need a couple of seconds to trust a periodicity estimate.
  if (n < rate * 2) return { bpm: null, confidence: 0 };

  // Mean-subtract so a constant (loud but steady) envelope autocorrelates to 0.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float64Array(n);
  let e0 = 0;
  for (let i = 0; i < n; i++) {
    const v = env[i] - mean;
    x[i] = v;
    e0 += v * v;
  }
  if (e0 < 1e-9) return { bpm: null, confidence: 0 };

  const lagMin = Math.max(1, Math.floor((rate * 60) / maxBpm));
  const lagMax = Math.min(n - 1, Math.ceil((rate * 60) / minBpm));
  const ac = new Float64Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += x[i] * x[i + lag];
    ac[lag] = s / e0;
  }

  const prior = (bpm: number) =>
    Math.exp(-0.5 * (Math.log2(bpm / preferBpm) / preferWidth) ** 2);

  // First pass: prior-weighted peak of the raw autocorrelation.
  let bestLag = lagMin;
  let best = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const score = ac[lag] * prior((60 * rate) / lag);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }

  // Second pass: resolve half/double/third errors by scoring a small harmonic
  // comb around the winner — the true beat period also correlates at 2× and 3×.
  bestLag = resolveOctave(ac, bestLag, lagMin, lagMax, rate, prior);

  const confidence = ac[bestLag];
  if (confidence < minConfidence) return { bpm: null, confidence };

  const refined = parabolicPeak(ac, bestLag, lagMin, lagMax);
  return { bpm: (60 * rate) / refined, confidence };
}

function acAt(
  ac: Float64Array,
  idx: number,
  lagMin: number,
  lagMax: number,
): number {
  const i = Math.round(idx);
  return i >= lagMin && i <= lagMax ? ac[i] : 0;
}

/** Pick among {L, L/2, 2L, L/3, 3L} the period whose harmonic comb (period +
 * 2× + 3×), weighted by the tempo prior, is strongest. */
function resolveOctave(
  ac: Float64Array,
  bestLag: number,
  lagMin: number,
  lagMax: number,
  rate: number,
  prior: (bpm: number) => number,
): number {
  let winner = bestLag;
  let winnerScore = -Infinity;
  for (const factor of [1, 0.5, 2, 1 / 3, 3]) {
    const c = Math.round(bestLag * factor);
    if (c < lagMin || c > lagMax) continue;
    const comb =
      acAt(ac, c, lagMin, lagMax) +
      acAt(ac, 2 * c, lagMin, lagMax) +
      acAt(ac, 3 * c, lagMin, lagMax);
    const score = comb * prior((60 * rate) / c);
    if (score > winnerScore) {
      winnerScore = score;
      winner = c;
    }
  }
  return winner;
}

/** Sub-sample peak location via a 3-point parabola around `lag`. */
function parabolicPeak(
  ac: Float64Array,
  lag: number,
  lagMin: number,
  lagMax: number,
): number {
  if (lag <= lagMin || lag >= lagMax) return lag;
  const a = ac[lag - 1];
  const b = ac[lag];
  const c = ac[lag + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return lag;
  const delta = (0.5 * (a - c)) / denom;
  return delta > -1 && delta < 1 ? lag + delta : lag;
}

/** Resample an irregularly-timed series onto a uniform grid (linear interp).
 * Timestamps must be non-decreasing. */
export function resampleUniform(
  timesMs: number[],
  values: number[],
  outRate: number,
): Float32Array {
  const nIn = timesMs.length;
  if (nIn === 0) return new Float32Array(0);
  if (nIn === 1) return Float32Array.of(values[0]);

  const step = 1000 / outRate;
  const start = timesMs[0];
  const span = timesMs[nIn - 1] - start;
  const nOut = Math.max(1, Math.floor(span / step) + 1);
  const out = new Float32Array(nOut);

  let j = 0;
  for (let i = 0; i < nOut; i++) {
    const t = start + i * step;
    while (j < nIn - 2 && timesMs[j + 1] < t) j++;
    const t0 = timesMs[j];
    const t1 = timesMs[j + 1];
    const frac = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
    out[i] = values[j] + (values[j + 1] - values[j]) * frac;
  }
  return out;
}

export interface OnsetFlux {
  /** Half-wave-rectified log-magnitude spectral flux of `frame` vs the previous
   * frame. Returns 0 for the very first frame (no predecessor). */
  push(frame: Float32Array): number;
}

/** Streaming spectral-flux onset detector over Hann-windowed FFT frames. */
export function createOnsetFlux(fftSize: number): OnsetFlux {
  const fft = new ComplexFft(fftSize);
  const win = makeHannWindow(fftSize);
  const half = fftSize >> 1;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  let prevMag = new Float32Array(half);
  let curMag = new Float32Array(half);
  let first = true;

  return {
    push(frame: Float32Array): number {
      for (let i = 0; i < fftSize; i++) {
        re[i] = frame[i] * win[i];
        im[i] = 0;
      }
      fft.forward(re, im);
      let f = 0;
      for (let k = 0; k < half; k++) {
        // Log compression emphasizes onsets over sustained loud content.
        const mag = Math.log1p(Math.hypot(re[k], im[k]));
        curMag[k] = mag;
        if (!first) {
          const d = mag - prevMag[k];
          if (d > 0) f += d; // half-wave rectified: only rising energy is onset
        }
      }
      const swap = prevMag;
      prevMag = curMag;
      curMag = swap;
      first = false;
      return f;
    },
  };
}

export interface CollectOptions {
  /** How long to listen, in ms. */
  durationMs?: number;
  /** Uniform envelope sample rate for the estimator, in Hz. */
  outRate?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Listen to `analyser` for `durationMs`, building an onset envelope and
 * estimating tempo. Returns the AUDIBLE bpm — the caller divides by the media
 * element's playback rate to recover the base (1×) tempo.
 *
 * Returns `{ bpm: null }` when the window is near-silent, non-rhythmic, or the
 * poll cadence collapsed (e.g. a background-throttled tab).
 */
export async function detectBpmFromAnalyser(
  analyser: AnalyserNode,
  opts: TempoOptions & CollectOptions = {},
  shouldAbort?: () => boolean,
): Promise<BpmEstimate> {
  const { durationMs = 10000, outRate = 100, ...tempoOpts } = opts;
  const n = analyser.fftSize;
  const onset = createOnsetFlux(n);
  const buf = new Float32Array(n);

  const times: number[] = [];
  const flux: number[] = [];
  const rmsValues: number[] = [];

  const t0 = performance.now();
  let firstFrame = true;

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (shouldAbort?.()) {
        resolve();
        return;
      }
      const now = performance.now();
      analyser.getFloatTimeDomainData(buf);

      let sumSq = 0;
      for (let i = 0; i < n; i++) sumSq += buf[i] * buf[i];
      rmsValues.push(Math.sqrt(sumSq / n));

      const f = onset.push(buf);
      // Skip the first frame (no predecessor → flux is 0 by definition).
      if (!firstFrame) {
        times.push(now - t0);
        flux.push(f);
      }
      firstFrame = false;

      if (now - t0 >= durationMs) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  if (flux.length < 2) return { bpm: null, confidence: 0 };
  // Near-silent window (paused / muted): nothing to measure.
  if (median(rmsValues) < 1e-3) return { bpm: null, confidence: 0 };
  // Degraded cadence (background-tab throttling collapsed the envelope).
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
  if (median(intervals) > 60) return { bpm: null, confidence: 0 };

  const env = resampleUniform(times, flux, outRate);
  return estimateTempoFromEnvelope(env, outRate, tempoOpts);
}
