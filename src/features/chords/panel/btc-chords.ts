/** BTC chord/key detection engine (side panel).
 *
 * Runs the BTC transformer (ONNX, int8) via onnxruntime-web's WASM backend to
 * label chords from live audio. The engine receives mono PCM batches (at the
 * page's sample rate) streamed from the content-script tap, keeps a rolling
 * window of recent audio, and every tick: resamples that window to 22050 Hz,
 * computes the librosa-matched CQT (cqt.ts), runs BTC on the most recent
 * 108-frame (~10 s) instance, and folds the per-frame chord labels into a
 * growing chart. WASM/ONNX must run here (extension CSP), never in the page.
 *
 * onnxruntime-web is dynamically imported on first use so it (and the model)
 * stay out of the panel's initial bundle.
 */
import type * as Ort from 'onnxruntime-web/wasm';
import type { ChordChart } from '../../../core/model/types';
import { BTC_CQT, Cqt } from './cqt';
import { buildSegments, keyFromSegments, NO_CHORD, type LabeledFrame } from './chord-decode';

const TARGET_SR = 22050;
const HOP = 2048;
const N_BINS = 144;
const TIMESTEP = 108; // BTC instance length (~10 s)
const FRAME_SEC = HOP / TARGET_SR; // ~0.0929 s
/** Recent audio kept for each inference (one instance + margin). */
const WINDOW_SEC = 12;
/** Inference cadence. */
const TICK_MS = 1500;

/** BTC 25-class vocab (idx2chord) → display labels ("C:min" → "Cm"). */
const BTC_LABELS: string[] = [
  'C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'D#', 'D#m', 'E', 'Em',
  'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'G#', 'G#m', 'A', 'Am',
  'A#', 'A#m', 'B', 'Bm', NO_CHORD,
];

export interface BtcEngineOptions {
  onChart: (chart: ChordChart) => void;
  /** Current track duration (seconds) for coverage. */
  getDuration: () => number;
}

export class BtcChordEngine {
  #opts: BtcEngineOptions;
  #ort: typeof Ort | null = null;
  #session: Ort.InferenceSession | null = null;
  #loading: Promise<void> | null = null;
  #cqt = new Cqt(BTC_CQT);

  #native = new Float32Array(0);
  #nativeRate = 48000;
  #speed = 1; // el.playbackRate of the newest batch (tap is downstream of it)
  #endTime = 0; // media time of the newest native sample
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #busy = false;

  /** Accumulated per-frame chord index, keyed by frame = round(mediaTime/FRAME_SEC). */
  #labels = new Map<number, number>();

  constructor(opts: BtcEngineOptions) {
    this.#opts = opts;
  }

  /** Resolves once the ONNX session exists. Rejects on load failure — the memo
   * is cleared so a later attempt retries. Await this before start(). */
  async ready(): Promise<void> {
    await this.#ensureSession();
  }

  /** Begin a fresh detection session (call after ready() has resolved). */
  start() {
    if (!this.#session) return;
    this.#labels.clear();
    this.#native = new Float32Array(0);
    this.#running = true;
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.#tick(), TICK_MS);
    }
  }

  stop() {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#native = new Float32Array(0);
  }

  dispose() {
    this.stop();
    this.#session = null;
  }

  /** Ingest a mono PCM batch from the engine tap. `speed` is the playback rate
   * the batch was captured at (the tap sits downstream of `el.playbackRate`). */
  pushPcm(samples: Float32Array | number[], sampleRate: number, t: number, speed = 1) {
    if (!this.#running) return;
    this.#nativeRate = sampleRate;
    this.#speed = speed;

    const add = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    // Seek guard: contiguous playback advances media time by ~one batch (in
    // media seconds, hence ×speed) per push. A jump beyond that means the audio
    // no longer maps to contiguous time — start the window fresh.
    const batchMediaDur = (add.length / sampleRate) * speed;
    if (Math.abs(t - (this.#endTime + batchMediaDur)) > Math.max(0.5, batchMediaDur)) {
      this.#native = new Float32Array(0);
    }
    const merged = new Float32Array(this.#native.length + add.length);
    merged.set(this.#native);
    merged.set(add, this.#native.length);
    const maxLen = Math.ceil(WINDOW_SEC * sampleRate);
    this.#native = merged.length > maxLen ? merged.slice(merged.length - maxLen) : merged;
    this.#endTime = t;
  }

  async #ensureSession() {
    if (this.#session) return;
    if (!this.#loading) {
      const loading = (async () => {
        const ort = await import('onnxruntime-web/wasm');
        // Single-threaded: no SharedArrayBuffer / blob worker (extension pages
        // aren't cross-origin isolated). The .wasm is bundled by Vite and its
        // URL rewired to the extension origin — no wasmPaths / CDN needed.
        ort.env.wasm.numThreads = 1;
        this.#ort = ort;
        this.#session = await ort.InferenceSession.create(
          browser.runtime.getURL('/models/btc.onnx'),
          { executionProviders: ['wasm'] },
        );
      })();
      this.#loading = loading;
      // Clear the memo on failure so a later toggle retries a transient
      // wasm-init/OOM error instead of re-awaiting the same rejection forever.
      loading.catch(() => {
        if (this.#loading === loading) this.#loading = null;
      });
    }
    await this.#loading;
  }

  async #tick() {
    if (!this.#running || this.#busy || !this.#session || !this.#ort) return;
    // Need roughly a full window before the first inference (~10 s of context).
    if (this.#native.length < this.#nativeRate * (WINDOW_SEC - 1.5)) return;
    this.#busy = true;
    try {
      const endTime = this.#endTime;
      const speed = this.#speed;
      const res = await resampleTo(this.#native, this.#nativeRate, TARGET_SR);
      const totalFrames = 1 + Math.floor(res.length / HOP);
      if (totalFrames < TIMESTEP) return;

      const startFrame = totalFrames - TIMESTEP;
      // Only the newest TIMESTEP frames feed BTC, so skip recomputing the ~2 s of
      // older history the rolling window still carries (earlier rows stay zero).
      const { data } = this.#cqt.logCqt(res, startFrame);
      const input = data.slice(startFrame * N_BINS, totalFrames * N_BINS); // [108*144]
      const tensor = new this.#ort.Tensor('float32', input, [1, TIMESTEP, N_BINS]);
      const out = await this.#session.run({ cqt: tensor });
      const logits = out.logits.data as Float32Array; // [108*25]

      // Map each CQT frame to absolute media time. The tap is downstream of
      // el.playbackRate, so `resLen` real-time samples span speed×(resLen/SR)
      // media seconds — scale by speed (cf. detect-bpm dividing bpm by rate).
      const resLen = res.length;
      const frameMediaDur = speed * FRAME_SEC; // media seconds one CQT hop covers
      for (let i = 0; i < TIMESTEP; i++) {
        let best = 0;
        for (let c = 1; c < 25; c++) if (logits[i * 25 + c] > logits[i * 25 + best]) best = c;
        const f = startFrame + i;
        const tStart = endTime - (speed * (resLen - f * HOP)) / TARGET_SR;
        if (tStart < 0) continue;
        // Paint the label across its media duration onto the fixed 1× grid, so
        // the chart stays contiguous and correctly timed at any playback speed.
        const slot0 = Math.round(tStart / FRAME_SEC);
        const slotEnd = Math.max(slot0 + 1, Math.round((tStart + frameMediaDur) / FRAME_SEC));
        for (let slot = slot0; slot < slotEnd; slot++) this.#labels.set(slot, best);
      }
      this.#emit();
    } catch (err) {
      console.error('[note-by-note] chord inference failed', err);
    } finally {
      this.#busy = false;
    }
  }

  #emit() {
    const keys = [...this.#labels.keys()].sort((a, b) => a - b);
    if (keys.length === 0) return;
    const frames: LabeledFrame[] = keys.map((k) => ({
      t: k * FRAME_SEC,
      label: BTC_LABELS[this.#labels.get(k)!],
    }));
    const segments = buildSegments(frames, FRAME_SEC);
    const duration = this.#opts.getDuration();
    const coverage = duration > 0 ? Math.min(1, (keys.length * FRAME_SEC) / duration) : 0;
    const live: ChordChart = {
      segments,
      key: keyFromSegments(segments),
      coverage,
      analyzedFrom: keys[0] * FRAME_SEC,
      analyzedTo: (keys[keys.length - 1] + 1) * FRAME_SEC,
      computedAt: Date.now(),
    };
    this.#opts.onChart(live);
  }
}

/** Resample mono audio to `targetRate` via OfflineAudioContext (browser-quality
 * resampler, matching librosa.load's high-quality resample). */
async function resampleTo(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array> {
  if (sourceRate === targetRate || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const ctx = new OfflineAudioContext(1, outLen, targetRate);
  const buf = ctx.createBuffer(1, input.length, sourceRate);
  buf.getChannelData(0).set(input);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}
