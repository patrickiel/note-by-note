// Run with: pnpm test:dsp (node --test).
// Light sanity checks for the CQT front-end. The exhaustive validation (JS CQT
// vs librosa, and 100% BTC label agreement) was done offline against the golden
// reference; here we just guard framing and pitch localization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTC_CQT, C1_HZ, Cqt } from './cqt.ts';

/** A pure tone at `freq` for `len` samples at the BTC sample rate (22050). */
function tone(freq: number, len: number): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / BTC_CQT.sampleRate);
  return out;
}

test('CQT frame count matches librosa center=True (1 + floor(len/hop))', () => {
  const cqt = new Cqt();
  const { frames } = cqt.logCqt(new Float32Array(BTC_CQT.sampleRate * 10)); // 10 s
  assert.equal(frames, 1 + Math.floor((BTC_CQT.sampleRate * 10) / BTC_CQT.hop));
});

test('CQT localizes a pure tone to the correct bin', () => {
  const cqt = new Cqt();
  // A4 = 440 Hz. Bin index = round(bpo * log2(f / fmin)).
  const expected = Math.round(BTC_CQT.binsPerOctave * Math.log2(440 / C1_HZ));
  const { frames, nBins, data } = cqt.logCqt(tone(440, BTC_CQT.sampleRate * 2));
  const mid = Math.floor(frames / 2);
  let peak = 0;
  for (let k = 1; k < nBins; k++) {
    if (data[mid * nBins + k] > data[mid * nBins + peak]) peak = k;
  }
  // Within a bin of the exact center (2 bins/semitone).
  assert.ok(Math.abs(peak - expected) <= 1, `peak ${peak} near expected ${expected}`);
});
