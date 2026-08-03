/** Rubber Band pitch-shift AudioWorklet — bundled by
 * scripts/build-rubberband-worklet.mjs into
 * public/worklets/rubberband-worklet.js, with the GPL Rubber Band WASM
 * (public/worklets/rb.wasm) fetched on the main thread and handed in via
 * `processorOptions.wasmBytes`. Instantiating from bytes keeps it CSP-safe
 * (no Blob URL / eval), and needs `wasm-unsafe-eval` (already in the manifest).
 *
 * Runs Rubber Band's realtime R3 ("Finer") engine — the highest-quality
 * pitch shifter — with formant preservation. Speed is handled upstream by
 * `el.playbackRate`; this worklet only pitch-shifts (time ratio stays 1), so a
 * playbackRate change is compensated back to constant pitch via `netSemitones`
 * in the pipeline.
 *
 * The pipeline drives it over the port with the same StretchNode surface the
 * old signalsmith worklet exposed: `schedule({ semitones })`,
 * `configure({ highQuality })`, `stop`. */

import Rubberband, {
  type RubberBandModule,
} from '@echogarden/rubberband-wasm';

// AudioWorkletGlobalScope globals (not in TS's DOM lib). Module-scoped ambients.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor,
): void;
declare const sampleRate: number;

// RubberBandOptions (rubberband-c.h). EngineFaster is 0 (the default engine).
const OptionProcessRealTime = 0x00000001;
const OptionEngineFiner = 0x20000000; // R3 "Finer" — best quality
const OptionPitchHighConsistency = 0x04000000; // stable through pitch changes

// Formant preservation. Default OFF; opt-in via the "Natural vocals" setting
// (folded into the options bitmask below). It keeps vocals natural when
// transposing up, but it holds the spectral envelope in place, which strongly
// attenuates narrowband/tonal content the further it is shifted — measured
// ~35 dB down on a pure tone at +12 st, vs full level with it off. Off gives
// content-neutral, full-level shifting (best for instrumental material).
const OptionFormantPreserved = 0x01000000;

/** R3 "Finer": the quality target. */
const OPTIONS_HIGH_QUALITY =
  OptionProcessRealTime | OptionEngineFiner | OptionPitchHighConsistency;
/** R2 "Faster": lower latency, lower quality — the "Low latency" setting. */
const OPTIONS_LOW_LATENCY = OptionProcessRealTime;

const BLOCK = 128; // Web Audio render quantum
const CHANNELS = 2;
const FADE_LEN = 256; // equal-power ramp masking startup/engine-swap discontinuity

/** Fixed-capacity mono ring buffer — decouples Rubber Band's bursty, internally
 * hop-aligned output from the fixed 128-frame render quantum so we never emit a
 * half-filled (glitchy) block. Preallocated: no per-block allocation on the
 * audio thread. */
class Ring {
  #buf: Float32Array;
  #cap: number;
  #read = 0;
  #write = 0;
  #count = 0;

  constructor(cap: number) {
    this.#cap = cap;
    this.#buf = new Float32Array(cap);
  }

  get count(): number {
    return this.#count;
  }

  clear(): void {
    this.#read = 0;
    this.#write = 0;
    this.#count = 0;
  }

  push(src: Float32Array, len: number): void {
    for (let i = 0; i < len; i++) {
      this.#buf[this.#write] = src[i];
      this.#write = (this.#write + 1) % this.#cap;
      if (this.#count < this.#cap) this.#count++;
      else this.#read = (this.#read + 1) % this.#cap; // overflow: drop oldest
    }
  }

  /** Pops `len` samples into `dst`; zero-fills any shortfall. */
  pop(dst: Float32Array, len: number): void {
    for (let i = 0; i < len; i++) {
      if (this.#count > 0) {
        dst[i] = this.#buf[this.#read];
        this.#read = (this.#read + 1) % this.#cap;
        this.#count--;
      } else {
        dst[i] = 0;
      }
    }
  }
}

interface ScheduleMessage {
  type: 'schedule';
  semitones?: number;
}
interface ConfigureMessage {
  type: 'configure';
  highQuality?: boolean;
  formantPreserved?: boolean;
}
interface StopMessage {
  type: 'stop';
}
type InMessage = ScheduleMessage | ConfigureMessage | StopMessage;

class RubberBandProcessor extends AudioWorkletProcessor {
  #mod: RubberBandModule | null = null;
  #state = 0;
  #ready = false;
  #dead = false;

  #inPtr = 0; // float** — array of per-channel input pointers
  #outPtr = 0; // float** — array of per-channel output pointers
  #inCh: number[] = []; // per-channel float*
  #outCh: number[] = [];

  #pitchScale = 1;
  #highQuality = true;
  #formantPreserved = false;
  #options = OPTIONS_HIGH_QUALITY;

  #fifoL = new Ring(1 << 14);
  #fifoR = new Ring(1 << 14);
  #wetL = new Float32Array(BLOCK);
  #wetR = new Float32Array(BLOCK);
  #silence = new Float32Array(BLOCK);
  /** > 0 while producing; drives the dry→wet fade. Reset when the FIFO drains
   * below a block (startup / after an engine swap). */
  #producing = false;
  #fade = 0;

  constructor(options?: unknown) {
    super();
    const wasmBytes = (
      options as { processorOptions?: { wasmBytes?: ArrayBuffer } } | undefined
    )?.processorOptions?.wasmBytes;
    this.port.onmessage = (e: MessageEvent<InMessage>) =>
      this.#onMessage(e.data);
    void this.#init(wasmBytes);
  }

  async #init(wasmBytes?: ArrayBuffer): Promise<void> {
    try {
      if (!wasmBytes) throw new Error('missing wasm bytes');
      const mod = await Rubberband({
        wasmBinary: wasmBytes,
        instantiateWasm: (
          imports: WebAssembly.Imports,
          success: (
            instance: WebAssembly.Instance,
            module: WebAssembly.Module,
          ) => void,
        ) => {
          void WebAssembly.instantiate(wasmBytes, imports).then((r) =>
            success(r.instance, r.module),
          );
          return {};
        },
      });
      this.#mod = mod;

      this.#inPtr = mod._malloc(CHANNELS * 4);
      this.#outPtr = mod._malloc(CHANNELS * 4);
      for (let c = 0; c < CHANNELS; c++) {
        const ip = mod._malloc(BLOCK * 4);
        const op = mod._malloc(BLOCK * 4);
        this.#inCh.push(ip);
        this.#outCh.push(op);
        mod.HEAPU32[(this.#inPtr >> 2) + c] = ip;
        mod.HEAPU32[(this.#outPtr >> 2) + c] = op;
      }

      this.#createStretcher();
      this.#ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({
        type: 'error',
        error: String((e as Error)?.stack || e),
      });
    }
  }

  /** (Re)creates the Rubber Band instance. Called on init and whenever the
   * engine option changes (high-quality R3 ⇄ low-latency R2), which Rubber Band
   * can only switch by rebuilding the stretcher. */
  #createStretcher(): void {
    const mod = this.#mod;
    if (!mod) return;
    if (this.#state) {
      mod._rubberband_delete(this.#state);
      this.#state = 0;
    }
    this.#state = mod._rubberband_new(sampleRate, CHANNELS, this.#options, 1, 1);
    mod._rubberband_set_max_process_size(this.#state, BLOCK);
    mod._rubberband_set_pitch_scale(this.#state, this.#pitchScale);
    this.#fifoL.clear();
    this.#fifoR.clear();
    this.#producing = false;
    this.#fade = 0;
  }

  /** Folds the engine choice and formant flag into the options bitmask. Rubber
   * Band can only change these by rebuilding, so a real change rebuilds the
   * stretcher (the dry→wet fade masks the discontinuity). */
  #recomputeOptions(): void {
    let next = this.#highQuality ? OPTIONS_HIGH_QUALITY : OPTIONS_LOW_LATENCY;
    if (this.#formantPreserved) next |= OptionFormantPreserved;
    if (next !== this.#options) {
      this.#options = next;
      if (this.#ready) this.#createStretcher();
    }
  }

  #onMessage(msg: InMessage): void {
    if (!msg) return;
    switch (msg.type) {
      case 'schedule': {
        this.#pitchScale = Math.pow(2, (msg.semitones ?? 0) / 12);
        if (this.#ready && this.#state) {
          this.#mod!._rubberband_set_pitch_scale(this.#state, this.#pitchScale);
        }
        break;
      }
      case 'configure': {
        // Engine choice (R3/R2) and formant preservation are independent flags
        // that both live in the options bitmask; update only the ones this
        // message carries so a partial configure never clobbers the other.
        if (msg.highQuality !== undefined) this.#highQuality = msg.highQuality;
        if (msg.formantPreserved !== undefined)
          this.#formantPreserved = msg.formantPreserved;
        this.#recomputeOptions();
        break;
      }
      case 'stop':
        this.#dispose();
        break;
    }
  }

  #dispose(): void {
    this.#dead = true;
    const mod = this.#mod;
    if (!mod) return;
    if (this.#state) {
      mod._rubberband_delete(this.#state);
      this.#state = 0;
    }
    for (const p of this.#inCh) mod._free(p);
    for (const p of this.#outCh) mod._free(p);
    if (this.#inPtr) mod._free(this.#inPtr);
    if (this.#outPtr) mod._free(this.#outPtr);
    this.#mod = null;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.#dead) return false;

    const out = outputs[0];
    const outL = out[0];
    const outR = out[1];
    const n = outL.length;

    const inL = inputs[0]?.[0] ?? this.#silence;
    const inR = inputs[0]?.[1] ?? inL;

    const mod = this.#mod;
    if (!this.#ready || !mod || !this.#state || n !== BLOCK) {
      // Not ready (WASM still loading) or an unexpected quantum → pass through
      // dry so audio is never dropped.
      outL.set(inL.subarray(0, n));
      if (outR) outR.set(inR.subarray(0, n));
      return true;
    }

    // Feed this quantum in, then drain everything Rubber Band has produced into
    // the FIFO. Re-read HEAPF32 after each WASM call: the heap can grow (and the
    // JS view detach) during process()/retrieve().
    let heap = mod.HEAPF32;
    heap.set(inL, this.#inCh[0] >> 2);
    heap.set(inR, this.#inCh[1] >> 2);
    mod._rubberband_process(this.#state, this.#inPtr, BLOCK, false);

    // Retrieve only what's there: R3's output is hop-aligned, so the last pass
    // almost always holds a partial block, and asking for BLOCK anyway makes
    // Rubber Band log a short-read warning to stderr — i.e. a console.error per
    // render quantum, from the audio thread. Never exceeds BLOCK, so #outPtr
    // stays big enough.
    let avail: number;
    while ((avail = mod._rubberband_available(this.#state)) > 0) {
      const got = mod._rubberband_retrieve(this.#state, this.#outPtr, Math.min(avail, BLOCK));
      if (got <= 0) break;
      heap = mod.HEAPF32;
      const ol = this.#outCh[0] >> 2;
      const or = this.#outCh[1] >> 2;
      this.#fifoL.push(heap.subarray(ol, ol + got), got);
      this.#fifoR.push(heap.subarray(or, or + got), got);
    }

    if (this.#fifoL.count >= BLOCK) {
      this.#fifoL.pop(this.#wetL, BLOCK);
      this.#fifoR.pop(this.#wetR, BLOCK);
      if (!this.#producing) {
        this.#producing = true;
        this.#fade = FADE_LEN; // ramp in from dry to mask the startup edge
      }
      if (this.#fade > 0) {
        const done = FADE_LEN - this.#fade;
        for (let i = 0; i < BLOCK; i++) {
          const t = Math.min(1, (done + i + 1) / FADE_LEN);
          const w = Math.sin(0.5 * Math.PI * t);
          const d = Math.cos(0.5 * Math.PI * t);
          outL[i] = d * inL[i] + w * this.#wetL[i];
          if (outR) outR[i] = d * inR[i] + w * this.#wetR[i];
        }
        this.#fade = Math.max(0, this.#fade - BLOCK);
      } else {
        outL.set(this.#wetL);
        if (outR) outR.set(this.#wetR);
      }
    } else {
      // Startup latency fill (or a drained FIFO): emit dry until wet is ready.
      this.#producing = false;
      outL.set(inL.subarray(0, n));
      if (outR) outR.set(inR.subarray(0, n));
    }
    return true;
  }
}

registerProcessor('note-by-note-rubberband', RubberBandProcessor);
