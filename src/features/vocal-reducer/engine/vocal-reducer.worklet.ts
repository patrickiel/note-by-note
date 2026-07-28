/** AudioWorklet adapter around CenterCutEngine — bundled by
 * scripts/build-vocal-worklet.mjs into public/worklets/vocal-reducer-worklet.js
 * (pure JS, no WASM, so it loads even on pages whose CSP blocks the stretch
 * worklet's WASM compile). */
import { CenterCutEngine } from './center-cut-dsp';

// AudioWorkletGlobalScope globals — not in TS's DOM lib. Module-scoped
// ambients so they don't leak into the rest of the project.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;
declare const sampleRate: number;

class CenterCutProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'amount',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate' as const,
      },
      {
        // 0 = reduce (drop vocal), 1 = isolate (keep vocal). See center-cut-dsp.
        name: 'iso',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate' as const,
      },
    ];
  }

  #engine = new CenterCutEngine(sampleRate);
  #dead = false;
  #silence = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'dispose') this.#dead = true;
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    if (this.#dead) return false; // lets the node be GC'd
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    if (this.#silence.length < outL.length) {
      this.#silence = new Float32Array(outL.length);
    }
    // Input may briefly be absent (0 channels) during graph teardown; mono
    // sources are up-mixed to stereo by the node's explicit channelCount, but
    // duplicate defensively anyway.
    const inL = inputs[0]?.[0] ?? this.#silence;
    const inR = inputs[0]?.[1] ?? inL;
    this.#engine.pushBlock(
      inL,
      inR,
      outL,
      outR,
      outL.length,
      parameters.amount[0],
      parameters.iso[0],
    );
    return true;
  }
}

registerProcessor('note-by-note-center-cut', CenterCutProcessor);
