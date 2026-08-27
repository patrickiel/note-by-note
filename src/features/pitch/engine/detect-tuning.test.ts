// Run with: pnpm test:dsp (node --test, Node 24 type-stripping — hence the
// explicit .ts import extension).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTuningFromSpectra } from './detect-tuning.ts';
import { ComplexFft, makeHannWindow } from '../../../core/audio/fft.ts';

const SR = 48000;
const N = 32768;

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

/** dB-magnitude spectrum of a windowed frame (AnalyserNode-style layout). */
function spectrumOf(frame: Float32Array): Float32Array {
  const fft = new ComplexFft(N);
  const win = makeHannWindow(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = frame[i] * win[i];
  fft.forward(re, im);
  const out = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) {
    out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / N + 1e-12);
  }
  return out;
}

/** A chord of ET pitches (MIDI notes, with a few harmonics) tuned to `a4`,
 * over a bed of noise. */
function chordFrame(a4: number, midi: number[], noiseAmp: number): Float32Array {
  const frame = makeNoise(N);
  for (let i = 0; i < N; i++) frame[i] *= noiseAmp;
  for (const m of midi) {
    const f0 = a4 * 2 ** ((m - 69) / 12);
    for (let h = 1; h <= 4; h++) {
      const amp = 0.3 / h;
      const f = f0 * h;
      for (let i = 0; i < N; i++) {
        frame[i] += amp * Math.sin((2 * Math.PI * f * i) / SR);
      }
    }
  }
  return frame;
}

for (const a4 of [432, 440, 442, 445]) {
  test(`recovers A4 = ${a4} Hz from an ET chord`, () => {
    const spectra = [
      spectrumOf(chordFrame(a4, [48, 55, 60, 64, 67], 0.01)),
      spectrumOf(chordFrame(a4, [45, 52, 57, 60, 64], 0.01)),
    ];
    const est = estimateTuningFromSpectra(spectra, SR, N, { minFrames: 2 });
    assert.equal(est.hz, a4);
    assert.ok(est.confidence > 0.3, `confidence ${est.confidence}`);
    assert.equal(est.details.usedFrames, 2);
  });
}

test('silence yields no tuning', () => {
  const silent = new Float32Array(N / 2).fill(-Infinity);
  const est = estimateTuningFromSpectra([silent], SR, N);
  assert.equal(est.hz, null);
});

test('broadband noise yields no tuning', () => {
  // A realistic run's worth of frames (~4 s at the extension's cadence).
  const spectra = Array.from({ length: 10 }, (_, i) => spectrumOf(makeNoise(N, i + 1)));
  const est = estimateTuningFromSpectra(spectra, SR, N);
  assert.equal(est.hz, null, `got ${est.hz} at confidence ${est.confidence}`);
});

test('too few frames yields no tuning even when confident', () => {
  const spectra = [spectrumOf(chordFrame(442, [48, 55, 60, 64, 67], 0.01))];
  const est = estimateTuningFromSpectra(spectra, SR, N, { minFrames: 3 });
  assert.equal(est.hz, null);
  assert.ok(est.confidence > 0.3, 'the comb itself was confident');
  assert.equal(est.details.accepted, false);
});
