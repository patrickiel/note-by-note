/** Shared real/complex FFT primitives used by the DSP features (vocal-reducer
 * center-cut, speed BPM detection). Pure, dependency-free and DOM-free so it
 * runs both inside AudioWorklet bundles and under `node --test`.
 */

/** Periodic Hann window (denominator n, not n−1 — required for exact COLA). */
export function makeHannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

/** Iterative radix-2 complex FFT with precomputed twiddle/bit-reversal
 * tables. In-place, allocation-free after construction. */
export class ComplexFft {
  readonly n: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${n}`);
    }
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  forward(re: Float32Array, im: Float32Array): void {
    this.transform(re, im, false);
  }

  /** Includes the 1/n scaling. */
  inverse(re: Float32Array, im: Float32Array): void {
    this.transform(re, im, true);
    const inv = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }

  private transform(re: Float32Array, im: Float32Array, invert: boolean): void {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let base = 0; base < n; base += len) {
        for (let j = 0, t = 0; j < half; j++, t += step) {
          const wr = cos[t];
          const wi = invert ? sin[t] : -sin[t];
          const a = base + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
