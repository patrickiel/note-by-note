// Run with: pnpm test:dsp (node --test, Node 24 type-stripping — hence the
// explicit .ts import extension).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOnsetFlux,
  estimateTempoFromEnvelope,
  resampleUniform,
} from './detect-bpm.ts';

/** Deterministic pseudo-random in [−1, 1] (LCG). */
function makeNoise(len: number, seed = 12345): Float32Array {
  const out = new Float32Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s / 0x80000000 - 1;
  }
  return out;
}

interface ClickOptions {
  jitterMs?: number;
  noise?: number;
  seed?: number;
  /** Gaussian onset width, in samples. */
  width?: number;
}

/** Onset-novelty envelope: non-negative Gaussian bumps at the beat period. */
function clickEnvelope(
  bpm: number,
  seconds: number,
  rate: number,
  { jitterMs = 0, noise = 0, seed = 7, width = 1.5 }: ClickOptions = {},
): Float32Array {
  const n = Math.round(seconds * rate);
  const env = new Float32Array(n);
  const period = (60 * rate) / bpm;
  let s = (seed >>> 0) || 1;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
  for (let beat = 0; beat * period < n; beat++) {
    let center = beat * period;
    if (jitterMs) center += (rand() * jitterMs * rate) / 1000;
    const lo = Math.max(0, Math.floor(center - 3 * width));
    const hi = Math.min(n - 1, Math.ceil(center + 3 * width));
    for (let i = lo; i <= hi; i++) {
      env[i] += Math.exp(-0.5 * ((i - center) / width) ** 2);
    }
  }
  if (noise) {
    const nz = makeNoise(n, seed + 101);
    for (let i = 0; i < n; i++) env[i] += noise * Math.abs(nz[i]);
  }
  return env;
}

const RATE = 100;
const SECONDS = 10;

test('recovers a clean 120 BPM pulse train', () => {
  const { bpm, confidence } = estimateTempoFromEnvelope(
    clickEnvelope(120, SECONDS, RATE),
    RATE,
  );
  assert.ok(bpm !== null, 'expected a tempo');
  assert.ok(Math.abs(bpm! - 120) <= 1, `bpm=${bpm}`);
  assert.ok(confidence > 0.2, `confidence=${confidence}`);
});

test('recovers a clean 90 BPM pulse train', () => {
  const { bpm } = estimateTempoFromEnvelope(clickEnvelope(90, SECONDS, RATE), RATE);
  assert.ok(bpm !== null && Math.abs(bpm - 90) <= 1, `bpm=${bpm}`);
});

test('prefers 150 over its 75 BPM sub-harmonic (octave resolution)', () => {
  // Autocorrelation of a 150 BPM train also peaks strongly at the 75 BPM lag;
  // the prior + harmonic comb must land on 150, not 75.
  const { bpm } = estimateTempoFromEnvelope(clickEnvelope(150, SECONDS, RATE), RATE);
  assert.ok(bpm !== null, 'expected a tempo');
  assert.ok(Math.abs(bpm! - 150) <= 2, `bpm=${bpm}`);
});

test('returns null for a silent (flat) envelope', () => {
  const { bpm } = estimateTempoFromEnvelope(new Float32Array(SECONDS * RATE), RATE);
  assert.equal(bpm, null);
});

test('returns null for non-rhythmic noise', () => {
  const nz = makeNoise(SECONDS * RATE, 4242);
  const env = new Float32Array(nz.length);
  for (let i = 0; i < nz.length; i++) env[i] = Math.abs(nz[i]); // envelopes are ≥ 0
  const { bpm, confidence } = estimateTempoFromEnvelope(env, RATE);
  assert.equal(bpm, null, `bpm=${bpm}, confidence=${confidence}`);
});

test('recovers 100 BPM despite noise and timing jitter', () => {
  const { bpm } = estimateTempoFromEnvelope(
    clickEnvelope(100, SECONDS, RATE, { jitterMs: 12, noise: 0.25, seed: 99 }),
    RATE,
  );
  assert.ok(bpm !== null && Math.abs(bpm - 100) <= 3, `bpm=${bpm}`);
});

/** Synthetic audio: a decaying broadband noise burst on every beat. */
function makeClickAudio(
  bpm: number,
  seconds: number,
  sampleRate: number,
  seed = 31,
): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const sig = new Float32Array(n);
  const nz = makeNoise(n, seed);
  const period = (60 * sampleRate) / bpm;
  for (let beat = 0; beat * period < n; beat++) {
    const start = Math.round(beat * period);
    for (let i = 0; i < 900 && start + i < n; i++) {
      sig[start + i] += Math.exp(-i / 130) * nz[start + i];
    }
  }
  return sig;
}

test('flux → resample → estimate recovers BPM from synthetic audio', () => {
  // Faithful to the runtime: an AnalyserNode returns the latest `fftSize`
  // samples each poll, so consecutive ~60 Hz polls are a sliding window that
  // hops ~sampleRate/60 samples. Reproduce that and drive the real onset flux.
  const sampleRate = 44100;
  const fftSize = 2048;
  const pollHz = 60;
  const audio = makeClickAudio(110, 12, sampleRate);
  const flux = createOnsetFlux(fftSize);
  const hop = Math.round(sampleRate / pollHz);
  const frame = new Float32Array(fftSize);
  const times: number[] = [];
  const values: number[] = [];
  let idx = 0;
  for (let start = 0; start + fftSize <= audio.length; start += hop, idx++) {
    frame.set(audio.subarray(start, start + fftSize));
    const f = flux.push(frame);
    if (idx > 0) {
      times.push((idx * 1000) / pollHz);
      values.push(f);
    }
  }
  const env = resampleUniform(times, values, 100);
  const { bpm } = estimateTempoFromEnvelope(env, 100);
  assert.ok(bpm !== null && Math.abs(bpm - 110) <= 4, `bpm=${bpm}`);
});

test('resampleUniform recovers tempo from an irregular ~60 Hz series', () => {
  // Sample a 128 BPM click train at jittery ~60 Hz wall-clock timestamps, then
  // resample to 100 Hz — the estimate must survive the resampling path.
  const src = clickEnvelope(128, SECONDS, RATE, { width: 2 });
  const times: number[] = [];
  const values: number[] = [];
  let s = 5;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x80000000; // [0, 1)
  };
  let tMs = 0;
  while (tMs < SECONDS * 1000) {
    times.push(tMs);
    const idx = Math.min(src.length - 1, Math.round((tMs / 1000) * RATE));
    values.push(src[idx]);
    tMs += 14 + rand() * 6; // ~60 Hz with jitter
  }
  const env = resampleUniform(times, values, RATE);
  const { bpm } = estimateTempoFromEnvelope(env, RATE);
  assert.ok(bpm !== null && Math.abs(bpm - 128) <= 3, `bpm=${bpm}`);
});
