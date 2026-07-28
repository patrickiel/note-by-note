/** Constant-Q transform matching librosa.cqt's parameterization, used to build
 * the input features for the BTC chord model.
 *
 * BTC was trained on `librosa.cqt(y, sr=22050, n_bins=144, bins_per_octave=24,
 * hop_length=2048)` (librosa defaults: fmin=C1, filter_scale=1, norm=1,
 * scale=True, periodic-hann windows) followed by `log(abs(cqt)+1e-6)`. librosa
 * computes that via recursive octave downsampling; we use the direct
 * time-domain kernel definition (same Q, lengths, window, and √length scaling)
 * and apply a per-bin log-offset calibration (see BTC_CQT_CALIBRATION) so the
 * magnitudes line up with librosa's — per-bin transform scale is
 * content-independent, so one calibration vector generalizes.
 *
 * Pure, DOM-free — runs under `node --test` (see cqt.test.ts) and in the panel.
 */

export interface CqtParams {
  sampleRate: number;
  fmin: number;
  binsPerOctave: number;
  nBins: number;
  hop: number;
  filterScale: number;
}

/** C1 = librosa.note_to_hz('C1'). */
export const C1_HZ = 32.70319566257483;

/** The exact BTC feature config. */
export const BTC_CQT: CqtParams = {
  sampleRate: 22050,
  fmin: C1_HZ,
  binsPerOctave: 24,
  nBins: 144,
  hop: 2048,
  filterScale: 1,
};

export interface CqtFrames {
  frames: number;
  nBins: number;
  /** Row-major [frame*nBins + bin], log(magnitude + 1e-6), calibrated. */
  data: Float32Array;
}

export class Cqt {
  readonly p: CqtParams;
  /** Per-bin windowed phasor kernels (real/imag), L1-normalized. */
  #kre: Float32Array[] = [];
  #kim: Float32Array[] = [];
  /** Per-bin start offset (samples, relative to the frame center). */
  #kStart: Int32Array;
  /** Per-bin √length scaling (librosa scale=True) and calibration log-offset. */
  #binScale: Float32Array;
  #calib: Float32Array;
  #maxHalf = 0;

  constructor(params: CqtParams = BTC_CQT, calibration?: Float32Array) {
    this.p = params;
    const { sampleRate: sr, fmin, binsPerOctave: bpo, nBins, filterScale } = params;
    this.#kStart = new Int32Array(nBins);
    this.#binScale = new Float32Array(nBins);
    this.#calib = calibration ?? BTC_CQT_CALIBRATION;

    const alpha = (2 ** (2 / bpo) - 1) / (2 ** (2 / bpo) + 1);
    const Q = filterScale / alpha;

    for (let k = 0; k < nBins; k++) {
      const freq = fmin * 2 ** (k / bpo);
      const ilen = (Q * sr) / freq; // librosa filter length (float)
      // n = arange(-ilen//2, ilen//2), numpy floor-division semantics.
      const nStart = Math.floor(-ilen / 2);
      const nEnd = Math.floor(ilen / 2);
      const N = nEnd - nStart;
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      let l1 = 0;
      for (let j = 0; j < N; j++) {
        const n = nStart + j;
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / N); // periodic hann
        const theta = (n * 2 * Math.PI * freq) / sr;
        re[j] = w * Math.cos(theta);
        im[j] = w * Math.sin(theta);
        l1 += w; // |phasor|=1, so |windowed|=w
      }
      for (let j = 0; j < N; j++) {
        re[j] /= l1;
        im[j] /= l1;
      }
      this.#kre[k] = re;
      this.#kim[k] = im;
      this.#kStart[k] = nStart;
      this.#binScale[k] = 1 / Math.sqrt(ilen); // librosa scale=True
      this.#maxHalf = Math.max(this.#maxHalf, -nStart, nEnd);
    }
  }

  /** Compute the calibrated log-CQT of a mono signal (center=True framing,
   * zero-padded — librosa's default pad_mode='constant'; frame count
   * 1 + floor(len/hop)). Pass `fromFrame` to compute only frames
   * [fromFrame, frames); earlier rows stay zero, so a live detector needn't
   * recompute history it already holds. */
  logCqt(signal: Float32Array, fromFrame = 0): CqtFrames {
    const { hop, nBins } = this.p;
    const pad = this.#maxHalf;
    // Zero-pad both ends (librosa center=True, pad_mode='constant').
    const padded = new Float32Array(signal.length + 2 * pad);
    padded.set(signal, pad);
    const frames = 1 + Math.floor(signal.length / hop);
    const data = new Float32Array(frames * nBins);

    for (let f = Math.max(0, fromFrame); f < frames; f++) {
      const center = f * hop + pad; // padded coordinates
      for (let k = 0; k < nBins; k++) {
        const re = this.#kre[k];
        const im = this.#kim[k];
        const base = center + this.#kStart[k];
        const len = re.length;
        let sre = 0;
        let sim = 0;
        for (let j = 0; j < len; j++) {
          const s = padded[base + j];
          sre += s * re[j];
          sim += s * im[j];
        }
        const mag = Math.hypot(sre, sim) * this.#binScale[k];
        data[f * nBins + k] = Math.log(mag + 1e-6) + this.#calib[k];
      }
    }
    return { frames, nBins, data };
  }
}

/** Per-bin log-magnitude offset aligning our direct-kernel CQT to librosa.cqt
 * (absorbs librosa's per-octave downsampling scale — content-independent).
 * Derived once from the BTC golden reference: correlation 0.994, and 100% BTC
 * label agreement vs a true librosa.cqt on validation windows. */
// prettier-ignore
export const BTC_CQT_CALIBRATION = Float32Array.from([
  9.98801, 9.96129, 9.91805, 9.86831, 9.85692, 9.84028, 9.83221, 9.80805,
  9.77152, 9.71643, 9.75345, 9.70960, 9.64230, 9.64205, 9.65014, 9.57744,
  9.53443, 9.54125, 9.49339, 9.44602, 9.46196, 9.42095, 9.39794, 9.38968,
  9.32393, 9.22955, 9.23597, 9.19273, 9.15337, 9.12633, 9.06907, 9.03587,
  8.99384, 8.93530, 9.00962, 9.01056, 8.96673, 8.92669, 8.90692, 8.85368,
  8.82946, 8.86617, 8.83226, 8.77879, 8.73335, 8.69673, 8.66760, 8.65028,
  8.57230, 8.54989, 8.56090, 8.53347, 8.47222, 8.41659, 8.41922, 8.41105,
  8.36861, 8.32275, 8.33872, 8.33557, 8.30542, 8.24004, 8.22718, 8.17635,
  8.16866, 8.12596, 8.12997, 8.10315, 8.07446, 8.05802, 8.02623, 7.99026,
  7.96434, 7.90382, 7.88386, 7.85911, 7.83311, 7.82314, 7.77322, 7.73490,
  7.70859, 7.66624, 7.66447, 7.64596, 7.61555, 7.57423, 7.53529, 7.48558,
  7.47037, 7.43768, 7.41051, 7.40266, 7.40227, 7.35395, 7.31274, 7.28414,
  7.25489, 7.22601, 7.17719, 7.17500, 7.15727, 7.12413, 7.08794, 7.05115,
  7.00978, 6.99138, 6.94978, 6.95133, 6.92710, 6.88998, 6.85039, 6.80068,
  6.76866, 6.73980, 6.71789, 6.71928, 6.69790, 6.65790, 6.62284, 6.57016,
  6.55857, 6.52835, 6.50654, 6.48987, 6.45461, 6.41401, 6.39982, 6.38461,
  6.33609, 6.32616, 6.29917, 6.26961, 6.22144, 6.19964, 6.15574, 6.12891,
  6.10371, 6.07206, 6.04799, 6.04096, 6.01731, 5.98946, 5.97810, 5.90805,
]);
