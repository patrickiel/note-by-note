// Run with: pnpm test:dsp (node --test, Node 24 type-stripping — hence the
// explicit .ts import extension).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attenuateOutOfBand,
  CenterCutEngine,
  centerCutSpectrum,
  FFT_SIZE,
  MAX_CENTER_CUT,
} from './center-cut-dsp.ts';
import { ComplexFft } from '../../../core/audio/fft.ts';

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

/** Goertzel amplitude of a tone at `freq` over x[start, start+len). */
function goertzelAmp(
  x: Float32Array,
  start: number,
  len: number,
  freq: number,
  sampleRate: number,
): number {
  const omega = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = x[start + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(omega);
  const imag = s2 * Math.sin(omega);
  return (2 * Math.sqrt(real * real + imag * imag)) / len;
}

const db = (ratio: number) => 20 * Math.log10(ratio);

/** Streams stereo input through an engine in 128-frame quanta.
 * `iso` = 0 reduce (drop vocal), 1 isolate (keep vocal). */
function run(
  engine: CenterCutEngine,
  inL: Float32Array,
  inR: Float32Array,
  amount: number,
  iso = 0,
): { outL: Float32Array; outR: Float32Array } {
  const len = inL.length;
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const blockL = new Float32Array(128);
  const blockR = new Float32Array(128);
  for (let pos = 0; pos < len; pos += 128) {
    const frames = Math.min(128, len - pos);
    blockL.set(inL.subarray(pos, pos + frames));
    blockR.set(inR.subarray(pos, pos + frames));
    engine.pushBlock(blockL, blockR, blockL, blockR, frames, amount, iso);
    outL.set(blockL.subarray(0, frames), pos);
    outR.set(blockR.subarray(0, frames), pos);
  }
  return { outL, outR };
}

test('FFT forward/inverse roundtrip', () => {
  const n = FFT_SIZE;
  const fft = new ComplexFft(n);
  const re = makeNoise(n, 1);
  const im = makeNoise(n, 2);
  const origRe = re.slice();
  const origIm = im.slice();
  fft.forward(re, im);
  fft.inverse(re, im);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - origRe[i]) < 1e-4, `re[${i}]`);
    assert.ok(Math.abs(im[i] - origIm[i]) < 1e-4, `im[${i}]`);
  }
});

test('WOLA identity at amount 0 (idle path), delayed by exactly FFT_SIZE', () => {
  const engine = new CenterCutEngine(44100);
  const len = FFT_SIZE * 4;
  const inL = makeNoise(len, 3);
  const inR = makeNoise(len, 4);
  const { outL, outR } = run(engine, inL, inR, 0);
  for (let t = FFT_SIZE; t < len; t++) {
    assert.ok(Math.abs(outL[t] - inL[t - FFT_SIZE]) < 1e-3, `L[${t}]`);
    assert.ok(Math.abs(outR[t] - inR[t - FFT_SIZE]) < 1e-3, `R[${t}]`);
  }
});

test('anti-phase material passes the active FFT path untouched', () => {
  const engine = new CenterCutEngine(44100);
  const len = FFT_SIZE * 4;
  const inL = makeNoise(len, 5);
  const inR = new Float32Array(len);
  for (let i = 0; i < len; i++) inR[i] = -inL[i];
  const { outL } = run(engine, inL, inR, 1);
  for (let t = FFT_SIZE; t < len; t++) {
    assert.ok(Math.abs(outL[t] - inL[t - FFT_SIZE]) < 2e-3, `L[${t}]`);
  }
});

test('centerCutSpectrum: center bin capped at −20 dB, side bin untouched', () => {
  const n = FFT_SIZE;
  const re = new Float32Array(n);
  const im = new Float32Array(n);

  // Pure center at bin 100: L = R = 1 + 0i → packed X[k] = 1+i, X[n−k] = 1+i.
  const k = 100;
  re[k] = 1; im[k] = 1;
  re[n - k] = 1; im[n - k] = 1;
  // Pure side at bin 200: L = 1, R = −1 → X[k] = X[n−k] = 1−i.
  const s = 200;
  re[s] = 1; im[s] = -1;
  re[n - s] = 1; im[n - s] = -1;

  centerCutSpectrum(re, im, n, 12, 696, MAX_CENTER_CUT);

  // Center residual: L' = R' = 0.1 → X'[k] = X'[n−k] = 0.1 + 0.1i.
  assert.ok(Math.abs(re[k] - 0.1) < 1e-6, `re[k]=${re[k]}`);
  assert.ok(Math.abs(im[k] - 0.1) < 1e-6, `im[k]=${im[k]}`);
  assert.ok(Math.abs(re[n - k] - 0.1) < 1e-6, `re[m]=${re[n - k]}`);
  assert.ok(Math.abs(im[n - k] - 0.1) < 1e-6, `im[m]=${im[n - k]}`);
  // Side bin unchanged.
  assert.equal(re[s], 1);
  assert.equal(im[s], -1);
  assert.equal(re[n - s], 1);
  assert.equal(im[n - s], -1);
});

test('end-to-end: cuts in-band center, keeps bass and panned content', () => {
  const sr = 44100;
  const len = sr; // 1 s
  const inL = new Float32Array(len);
  const inR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const bass = 0.5 * Math.sin(2 * Math.PI * 80 * t); // center, below low cut
    const vocal = 0.5 * Math.sin(2 * Math.PI * 440 * t); // center, in band
    const side = 0.5 * Math.sin(2 * Math.PI * 2000 * t); // hard left, in band
    inL[i] = bass + vocal + side;
    inR[i] = bass + vocal;
  }
  const engine = new CenterCutEngine(sr);
  const { outL, outR } = run(engine, inL, inR, 1);

  // Measure the last 0.5 s (past latency + depth smoothing). All test
  // frequencies have an integer number of cycles in the window — no leakage.
  const win = sr / 2;
  const start = len - win;
  const inRef = (x: Float32Array, hz: number) => goertzelAmp(x, start, win, hz, sr);
  const out = (x: Float32Array, hz: number) => goertzelAmp(x, start, win, hz, sr);

  const vocalDropL = db(out(outL, 440) / inRef(inL, 440));
  const vocalDropR = db(out(outR, 440) / inRef(inR, 440));
  assert.ok(vocalDropL < -15, `vocal L dropped ${vocalDropL.toFixed(1)} dB`);
  assert.ok(vocalDropR < -15, `vocal R dropped ${vocalDropR.toFixed(1)} dB`);

  const bassDelta = db(out(outL, 80) / inRef(inL, 80));
  assert.ok(Math.abs(bassDelta) < 1.5, `bass moved ${bassDelta.toFixed(2)} dB`);

  const sideDelta = db(out(outL, 2000) / inRef(inL, 2000));
  assert.ok(Math.abs(sideDelta) < 1.5, `side moved ${sideDelta.toFixed(2)} dB`);
});

test('idle path unaffected by iso (amount 0 stays a passthrough)', () => {
  const engine = new CenterCutEngine(44100);
  const len = FFT_SIZE * 4;
  const inL = makeNoise(len, 7);
  const inR = makeNoise(len, 8);
  // Isolate selected but amount 0 → depth-gated idle path, identity passthrough.
  const { outL, outR } = run(engine, inL, inR, 0, 1);
  for (let t = FFT_SIZE; t < len; t++) {
    assert.ok(Math.abs(outL[t] - inL[t - FFT_SIZE]) < 1e-3, `L[${t}]`);
    assert.ok(Math.abs(outR[t] - inR[t - FFT_SIZE]) < 1e-3, `R[${t}]`);
  }
});

test('centerCutSpectrum isolate (iso=1): keeps center bin, removes side bin', () => {
  const n = FFT_SIZE;
  const re = new Float32Array(n);
  const im = new Float32Array(n);

  // Pure center at bin 100 and pure side at bin 200 (same fixture as reduce).
  const k = 100;
  re[k] = 1; im[k] = 1;
  re[n - k] = 1; im[n - k] = 1;
  const s = 200;
  re[s] = 1; im[s] = -1;
  re[n - s] = 1; im[n - s] = -1;

  centerCutSpectrum(re, im, n, 12, 696, MAX_CENTER_CUT, 1);

  // Center component preserved unchanged (the mirror image of reduce).
  assert.ok(Math.abs(re[k] - 1) < 1e-6, `re[k]=${re[k]}`);
  assert.ok(Math.abs(im[k] - 1) < 1e-6, `im[k]=${im[k]}`);
  assert.ok(Math.abs(re[n - k] - 1) < 1e-6, `re[m]=${re[n - k]}`);
  assert.ok(Math.abs(im[n - k] - 1) < 1e-6, `im[m]=${im[n - k]}`);
  // Pure side faded to the −20 dB floor: ×(1 − MAX_CENTER_CUT).
  const floor = 1 - MAX_CENTER_CUT;
  assert.ok(Math.abs(re[s] - floor) < 1e-6, `re[s]=${re[s]}`);
  assert.ok(Math.abs(im[s] + floor) < 1e-6, `im[s]=${im[s]}`);
  assert.ok(Math.abs(re[n - s] - floor) < 1e-6, `re[m_s]=${re[n - s]}`);
  assert.ok(Math.abs(im[n - s] + floor) < 1e-6, `im[m_s]=${im[n - s]}`);
});

test('attenuateOutOfBand scales only out-of-band bins (mirrors, DC, Nyquist)', () => {
  const n = 16;
  const loBin = 3;
  const hiBin = 5;
  const re = new Float32Array(n).fill(1);
  const im = new Float32Array(n).fill(1);
  attenuateOutOfBand(re, im, n, loBin, hiBin, 0.5);
  const half = n >> 1;
  for (let k = 0; k < n; k++) {
    // Fold each index to its logical bin in [0, half]; [loBin, hiBin] is kept.
    const bin = k <= half ? k : n - k;
    const expected = bin >= loBin && bin <= hiBin ? 1 : 0.5;
    assert.equal(re[k], expected, `re[${k}] (bin ${bin})`);
    assert.equal(im[k], expected, `im[${k}] (bin ${bin})`);
  }
});

test('end-to-end isolate: keeps centered vocal, drops sides and out-of-band', () => {
  const sr = 44100;
  const len = sr; // 1 s
  const inL = new Float32Array(len);
  const inR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const bass = 0.5 * Math.sin(2 * Math.PI * 80 * t); // center, below low cut
    const vocal = 0.5 * Math.sin(2 * Math.PI * 440 * t); // center, in band
    const side = 0.5 * Math.sin(2 * Math.PI * 2000 * t); // anti-phase, in band
    inL[i] = bass + vocal + side;
    inR[i] = bass + vocal - side;
  }
  const engine = new CenterCutEngine(sr);
  const { outL } = run(engine, inL, inR, 1, 1);

  const win = sr / 2;
  const start = len - win;
  const amp = (x: Float32Array, hz: number) => goertzelAmp(x, start, win, hz, sr);

  // Centered vocal preserved — isolate keeps the shared center component.
  const vocalDelta = db(amp(outL, 440) / amp(inL, 440));
  assert.ok(Math.abs(vocalDelta) < 2, `vocal moved ${vocalDelta.toFixed(2)} dB`);
  // Anti-phase (pure side) in-band material removed.
  const sideDelta = db(amp(outL, 2000) / amp(inL, 2000));
  assert.ok(sideDelta < -15, `side only dropped ${sideDelta.toFixed(1)} dB`);
  // Out-of-band bass (backing) faded out.
  const bassDelta = db(amp(outL, 80) / amp(inL, 80));
  assert.ok(bassDelta < -15, `bass only dropped ${bassDelta.toFixed(1)} dB`);
});
