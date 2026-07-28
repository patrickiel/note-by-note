import { EQ_BANDS } from '../../../core/model/defaults';

/**
 * Analytic magnitude response of the graphic EQ, used to draw a curve that
 * matches what {@link createEqualizer} actually does to the audio. The RBJ
 * cookbook coefficients and Q below MUST stay in sync with equalizer.ts.
 */

// Must match `filter.Q.value` in equalizer.ts.
const Q = 1.1;
// The panel has no AudioContext; the exact rate barely affects the shape below
// Nyquist, so we assume a common one for a stable, deterministic curve.
const SAMPLE_RATE = 48000;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

function peaking(f0: number, gainDb: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = Math.sin(w0) / (2 * Q);
  return {
    b0: 1 + alpha * A,
    b1: -2 * cos,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cos,
    a2: 1 - alpha / A,
  };
}

function lowshelf(f0: number, gainDb: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const A = Math.pow(10, gainDb / 40);
  // Web Audio fixes shelf slope S = 1, so Q is unused here.
  const beta = Math.sqrt(2 * A) * Math.sin(w0);
  return {
    b0: A * (A + 1 - (A - 1) * cos + beta),
    b1: 2 * A * (A - 1 - (A + 1) * cos),
    b2: A * (A + 1 - (A - 1) * cos - beta),
    a0: A + 1 + (A - 1) * cos + beta,
    a1: -2 * (A - 1 + (A + 1) * cos),
    a2: A + 1 + (A - 1) * cos - beta,
  };
}

function highshelf(f0: number, gainDb: number): Biquad {
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const A = Math.pow(10, gainDb / 40);
  const beta = Math.sqrt(2 * A) * Math.sin(w0);
  return {
    b0: A * (A + 1 + (A - 1) * cos + beta),
    b1: -2 * A * (A - 1 + (A + 1) * cos),
    b2: A * (A + 1 + (A - 1) * cos - beta),
    a0: A + 1 - (A - 1) * cos + beta,
    a1: 2 * (A - 1 - (A + 1) * cos),
    a2: A + 1 - (A - 1) * cos - beta,
  };
}

/** Magnitude of a biquad at frequency `f`, in dB. */
function magnitudeDb({ b0, b1, b2, a0, a1, a2 }: Biquad, f: number): number {
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const phi = Math.pow(Math.sin(w / 2), 2);
  const num =
    Math.pow(b0 + b1 + b2, 2) -
    4 * (b0 * b1 + 4 * b0 * b2 + b1 * b2) * phi +
    16 * b0 * b2 * phi * phi;
  const den =
    Math.pow(a0 + a1 + a2, 2) -
    4 * (a0 * a1 + 4 * a0 * a2 + a1 * a2) * phi +
    16 * a0 * a2 * phi * phi;
  return 10 * Math.log10(num / den);
}

function bandFilter(index: number, gainDb: number): Biquad {
  const f0 = EQ_BANDS[index];
  if (index === 0) return lowshelf(f0, gainDb);
  if (index === EQ_BANDS.length - 1) return highshelf(f0, gainDb);
  return peaking(f0, gainDb);
}

/**
 * Combined response of the whole EQ chain, sampled at `steps` log-spaced
 * frequencies from the lowest to the highest band. Returns, per sample, the
 * fractional x position (0..1, log-frequency) and the summed gain in dB —
 * series filters multiply in magnitude, i.e. add in dB.
 */
export function eqResponseCurve(
  gains: number[],
  steps = 160,
): { x: number; db: number }[] {
  const filters = EQ_BANDS.map((_, i) => bandFilter(i, gains[i] ?? 0));
  const logMin = Math.log2(EQ_BANDS[0]);
  const logMax = Math.log2(EQ_BANDS[EQ_BANDS.length - 1]);

  return Array.from({ length: steps }, (_, s) => {
    const x = s / (steps - 1);
    const f = Math.pow(2, logMin + x * (logMax - logMin));
    const db = filters.reduce((sum, bq) => sum + magnitudeDb(bq, f), 0);
    return { x, db };
  });
}
