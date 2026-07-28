/** Phase-aware STFT center-cut — the DSP core of the vocal reducer.
 *
 * Per frequency bin, estimate the component where L and R agree in magnitude
 * and phase (Avery Lee "Center Cut" / Audacity VocalRedIso) and subtract a
 * depth-scaled fraction of it, but only inside the vocal band
 * [LOW_CUT_HZ, HIGH_CUT_HZ] — bass, cymbals and panned material pass through
 * untouched, and the output stays stereo and mono-compatible.
 *
 * Pure, dependency-free and DOM-free so it runs both inside the AudioWorklet
 * bundle and under `node --test`. No allocations after construction.
 */

import { ComplexFft, makeHannWindow } from '../../../core/audio/fft.ts';

export const FFT_SIZE = 4096;
export const HOP_SIZE = FFT_SIZE / 4;
export const LOW_CUT_HZ = 120;
export const HIGH_CUT_HZ = 7500;
/** Max fraction of the center estimate removed (−20 dB floor): near-mono
 * material can never be fully silenced, and the residual masks musical noise. */
export const MAX_CENTER_CUT = 0.9;

const EPS = 1e-9;
const ACTIVE_EPS = 1e-4;
/** Hann² frames at 75% overlap sum to 3/2 — WOLA normalization. */
const WOLA_GAIN = 2 / 3;

/** Applies the center mask to a packed spectrum (FFT of L + i·R), in place,
 * for bins [loBin, hiBin] (must lie strictly inside (0, n/2)).
 *
 * Per bin, with L and R as ℝ² vectors: unit-bisector direction
 * C = L/|L| + R/|R|, and α chosen so the residuals are perpendicular,
 * (L−αC)·(R−αC) = 0 — i.e. α²|C|² − αC·(L+R) + L·R = 0, smaller root.
 * The shared center estimate is `center = αC`; the side (non-center) part of a
 * channel X is `X − center`.
 *
 * `iso` selects what gets removed, scaled by `depth` (0–1):
 *   - iso = 0 (reduce):  X' = X − depth·center           (drop the vocal)
 *   - iso = 1 (isolate): X' = X − depth·(X − center)     (keep the vocal, drop the sides)
 *   - blended in between so mode changes can crossfade.
 * At iso = 0 this is byte-identical to the original center-cut. */
export function centerCutSpectrum(
  re: Float32Array,
  im: Float32Array,
  n: number,
  loBin: number,
  hiBin: number,
  depth: number,
  iso: number = 0,
): void {
  // When no center can be estimated the bin is pure side (center = 0), so the
  // blend reduces to iso·X: reduce leaves it (×1), isolate fades it toward
  // silence. sideScale is exactly 1 at iso = 0, keeping reduce byte-identical.
  const sideScale = 1 - depth * iso;
  for (let k = loBin; k <= hiBin; k++) {
    const m = n - k;
    // Unpack the two real spectra: L = (X[k] + conj(X[m]))/2, R = (X[k] − conj(X[m]))/2i.
    const lr = (re[k] + re[m]) / 2;
    const li = (im[k] - im[m]) / 2;
    const rr = (im[k] + im[m]) / 2;
    const ri = (re[m] - re[k]) / 2;

    const magL = Math.sqrt(lr * lr + li * li);
    const magR = Math.sqrt(rr * rr + ri * ri);
    if (magL < EPS || magR < EPS) {
      re[k] *= sideScale; im[k] *= sideScale;
      re[m] *= sideScale; im[m] *= sideScale;
      continue;
    }

    const cr = lr / magL + rr / magR;
    const ci = li / magL + ri / magR;
    const a = cr * cr + ci * ci;
    if (a < EPS) {
      re[k] *= sideScale; im[k] *= sideScale; // anti-phase: pure side, no center
      re[m] *= sideScale; im[m] *= sideScale;
      continue;
    }

    const b = cr * (lr + rr) + ci * (li + ri);
    const d = lr * rr + li * ri;
    const disc = b * b - 4 * a * d;
    let alpha = (b - Math.sqrt(disc > 0 ? disc : 0)) / (2 * a);
    if (!(alpha > 0)) {
      re[k] *= sideScale; im[k] *= sideScale; // no positive center (also NaN)
      re[m] *= sideScale; im[m] *= sideScale;
      continue;
    }

    // center = αC (shared by L and R); side_X = X − center. Remove
    // depth·[(1−iso)·center + iso·side_X] from each channel.
    const centerR = alpha * cr;
    const centerI = alpha * ci;
    const blendLr = centerR + iso * (lr - 2 * centerR);
    const blendLi = centerI + iso * (li - 2 * centerI);
    const blendRr = centerR + iso * (rr - 2 * centerR);
    const blendRi = centerI + iso * (ri - 2 * centerI);
    const nlr = lr - depth * blendLr;
    const nli = li - depth * blendLi;
    const nrr = rr - depth * blendRr;
    const nri = ri - depth * blendRi;

    // Repack: X'[k] = L' + i·R', X'[m] = conj(L') + i·conj(R').
    re[k] = nlr - nri;
    im[k] = nli + nrr;
    re[m] = nlr + nri;
    im[m] = nrr - nli;
  }
}

/** Scales every out-of-band bin (both packed halves, plus DC and Nyquist) by
 * `factor`, in place. Used only for isolate: bass, kick and cymbals live
 * outside the vocal band and are backing, so isolate fades them toward silence.
 * Reduce never calls this, so its path is untouched. */
export function attenuateOutOfBand(
  re: Float32Array,
  im: Float32Array,
  n: number,
  loBin: number,
  hiBin: number,
  factor: number,
): void {
  const half = n >> 1;
  // Below the vocal band: bins [1, loBin) and their mirrors (n−1 … n−loBin+1].
  for (let k = 1; k < loBin; k++) {
    const m = n - k;
    re[k] *= factor;
    im[k] *= factor;
    re[m] *= factor;
    im[m] *= factor;
  }
  // Above the vocal band: bins (hiBin, half) and their mirrors.
  for (let k = hiBin + 1; k < half; k++) {
    const m = n - k;
    re[k] *= factor;
    im[k] *= factor;
    re[m] *= factor;
    im[m] *= factor;
  }
  // DC (bin 0) and Nyquist (bin half) are self-mirrored — scale once.
  re[0] *= factor;
  im[0] *= factor;
  re[half] *= factor;
  im[half] *= factor;
}

/** Streaming STFT machinery: input rings, hop scheduling, WOLA overlap-add,
 * per-hop depth smoothing, and a cheap windowed passthrough when idle (keeps
 * the delay line primed and time-aligned so re-engagement never fades in).
 *
 * Latency is exactly `fftSize` frames regardless of push granularity. */
export class CenterCutEngine {
  readonly fftSize: number;
  readonly hopSize: number;

  private readonly mask: number;
  private readonly fft: ComplexFft;
  private readonly hann: Float32Array;
  /** hann · 2/3 (synthesis) and hann² · 2/3 (idle passthrough). */
  private readonly synthWin: Float32Array;
  private readonly passWin: Float32Array;
  private readonly loBin: number;
  private readonly hiBin: number;
  private readonly smoothCoeff: number;

  private readonly inL: Float32Array;
  private readonly inR: Float32Array;
  private readonly olaL: Float32Array;
  private readonly olaR: Float32Array;
  private readonly fifoL: Float32Array;
  private readonly fifoR: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  private write = 0;
  private staged = 0;
  private olaPos = 0;
  private fifoWrite: number;
  private fifoRead = 0;
  private smoothed = 0;
  private smoothedIso = 0;

  constructor(sampleRate: number, fftSize: number = FFT_SIZE) {
    this.fftSize = fftSize;
    this.hopSize = fftSize / 4;
    this.mask = fftSize - 1;
    this.fft = new ComplexFft(fftSize);
    this.hann = makeHannWindow(fftSize);
    this.synthWin = new Float32Array(fftSize);
    this.passWin = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      this.synthWin[i] = this.hann[i] * WOLA_GAIN;
      this.passWin[i] = this.hann[i] * this.hann[i] * WOLA_GAIN;
    }
    this.loBin = Math.max(1, Math.ceil((LOW_CUT_HZ * fftSize) / sampleRate));
    this.hiBin = Math.min(
      (fftSize >> 1) - 1,
      Math.floor((HIGH_CUT_HZ * fftSize) / sampleRate),
    );
    // One-pole toward the target depth, ~30 ms time constant, per hop.
    this.smoothCoeff = 1 - Math.exp(-this.hopSize / (sampleRate * 0.03));

    this.inL = new Float32Array(fftSize);
    this.inR = new Float32Array(fftSize);
    this.olaL = new Float32Array(fftSize);
    this.olaR = new Float32Array(fftSize);
    this.fifoL = new Float32Array(fftSize);
    this.fifoR = new Float32Array(fftSize);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    // Prime the output FIFO with one hop of silence — this pins end-to-end
    // latency to exactly fftSize frames and guarantees the FIFO never
    // underruns (occupancy stays within [1, 2·hop]).
    this.fifoWrite = this.hopSize;
  }

  /** Processes `frames` samples; input and output may be the same arrays.
   * `iso` selects reduce (0) vs isolate (1); see centerCutSpectrum. */
  pushBlock(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    frames: number,
    amount: number,
    iso: number = 0,
  ): void {
    const target =
      Math.min(1, Math.max(0, amount)) * MAX_CENTER_CUT;
    const targetIso = Math.min(1, Math.max(0, iso));
    const mask = this.mask;
    for (let i = 0; i < frames; i++) {
      this.inL[this.write] = inL[i];
      this.inR[this.write] = inR[i];
      this.write = (this.write + 1) & mask;
      if (++this.staged === this.hopSize) {
        this.staged = 0;
        this.processHop(target, targetIso);
      }
      outL[i] = this.fifoL[this.fifoRead];
      outR[i] = this.fifoR[this.fifoRead];
      this.fifoRead = (this.fifoRead + 1) & mask;
    }
  }

  private processHop(target: number, targetIso: number): void {
    const { fftSize: n, hopSize: hop, mask, hann, synthWin, passWin, olaL, olaR, re, im } = this;
    this.smoothed += (target - this.smoothed) * this.smoothCoeff;
    this.smoothedIso += (targetIso - this.smoothedIso) * this.smoothCoeff;
    if (this.smoothed < ACTIVE_EPS && target < ACTIVE_EPS) {
      this.smoothed = 0;
      // Idle: WOLA passthrough without FFT — identical delay, ~free.
      for (let i = 0; i < n; i++) {
        const src = (this.write + i) & mask;
        const dst = (this.olaPos + i) & mask;
        olaL[dst] += this.inL[src] * passWin[i];
        olaR[dst] += this.inR[src] * passWin[i];
      }
    } else {
      // Analysis: window the newest n input samples, packed as L + i·R.
      for (let i = 0; i < n; i++) {
        const src = (this.write + i) & mask;
        re[i] = this.inL[src] * hann[i];
        im[i] = this.inR[src] * hann[i];
      }
      this.fft.forward(re, im);
      centerCutSpectrum(re, im, n, this.loBin, this.hiBin, this.smoothed, this.smoothedIso);
      // Isolate: fade out-of-band backing (bass/kick/cymbals) toward silence.
      const oob = this.smoothed * this.smoothedIso;
      if (oob > ACTIVE_EPS) {
        attenuateOutOfBand(re, im, n, this.loBin, this.hiBin, 1 - oob);
      }
      this.fft.inverse(re, im);
      for (let i = 0; i < n; i++) {
        const dst = (this.olaPos + i) & mask;
        olaL[dst] += re[i] * synthWin[i];
        olaR[dst] += im[i] * synthWin[i];
      }
    }
    for (let i = 0; i < hop; i++) {
      const src = (this.olaPos + i) & mask;
      this.fifoL[this.fifoWrite] = olaL[src];
      this.fifoR[this.fifoWrite] = olaR[src];
      olaL[src] = 0;
      olaR[src] = 0;
      this.fifoWrite = (this.fifoWrite + 1) & mask;
    }
    this.olaPos = (this.olaPos + hop) & mask;
  }
}
