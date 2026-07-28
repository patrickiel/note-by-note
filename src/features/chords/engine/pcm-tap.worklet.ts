/** AudioWorklet PCM tap — forwards mono PCM (at the context sample rate) to the
 * main thread in batches, so the side panel can run the BTC chord model on it.
 *
 * A silent analysis tap (no output audio). Pure JS, so it loads even where a
 * page's CSP blocks WASM. Gated by start/stop port messages — idle it's a cheap
 * no-op. Batches samples to keep the message rate low; buffers are transferred. */

// AudioWorkletGlobalScope globals — not in TS's DOM lib.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;

/** ~0.17 s at 48 kHz — batch to cut postMessage/port traffic. */
const BATCH = 8192;

class PcmTapProcessor extends AudioWorkletProcessor {
  #active = false;
  #dead = false;
  #buf = new Float32Array(BATCH);
  #n = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const type = e.data?.type;
      if (type === 'start') this.#active = true;
      else if (type === 'stop') {
        this.#active = false;
        this.#n = 0;
      } else if (type === 'dispose') this.#dead = true;
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.#dead) return false;
    if (!this.#active) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      this.#buf[this.#n++] = s / channels;
      if (this.#n === BATCH) {
        const chunk = this.#buf.slice(0, BATCH);
        this.port.postMessage({ type: 'pcm', samples: chunk }, [chunk.buffer]);
        this.#n = 0;
      }
    }
    return true;
  }
}

registerProcessor('note-by-note-pcm-tap', PcmTapProcessor);
