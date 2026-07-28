/** Methods the pipeline drives on the pitch worklet node. Kept as the historical
 * "stretch" surface (schedule/configure/stop/…) so pipeline.ts stays engine-
 * agnostic; the concrete engine is Rubber Band (see rubberband.worklet.ts). The
 * node forwards these to the processor over its port. */
export interface StretchNode extends AudioWorkletNode {
  schedule(segment: {
    active?: boolean;
    input?: number;
    output?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
  }): Promise<unknown>;
  start(when?: number): Promise<unknown>;
  stop(when?: number): Promise<unknown>;
  configure(config: {
    preset?: 'default' | 'cheaper';
    blockMs?: number;
    intervalMs?: number;
    splitComputation?: boolean;
    formantPreserved?: boolean;
  }): Promise<unknown>;
  latency(): Promise<number>;
  setUpdateInterval(seconds: number, callback: (inputTime: number) => void): void;
}

/** addModule is per-context; attach-audio reuses contexts across reattach. */
const registered = new WeakSet<BaseAudioContext>();

/** The GPL Rubber Band WASM, fetched once on the main thread and structured-
 * cloned into each worklet via processorOptions (Blob-URL/eval-free → CSP-safe).
 * Reset on failure so a transient fetch error doesn't wedge every later attach. */
let wasmBytesPromise: Promise<ArrayBuffer> | null = null;
function loadWasmBytes(): Promise<ArrayBuffer> {
  if (!wasmBytesPromise) {
    wasmBytesPromise = fetch(browser.runtime.getURL('/worklets/rb.wasm'))
      .then((r) => {
        if (!r.ok) throw new Error(`rb.wasm ${r.status}`);
        return r.arrayBuffer();
      })
      .catch((err) => {
        wasmBytesPromise = null;
        throw err;
      });
  }
  return wasmBytesPromise;
}

/** Firefox runs content scripts in their own sandbox realm, and an ArrayBuffer
 * minted there cannot be structured-cloned into the page realm: handing the
 * bytes to `processorOptions` throws DataCloneError, the node never constructs,
 * and every page reports "Pitch not available". `cloneInto` rebuilds the payload
 * in the page's realm. It is a Firefox content-script global — absent in
 * Chromium, and absent in our own extension pages (local player, offscreen),
 * where the script and the AudioContext already share a realm. */
type CloneInto = <T>(value: T, targetScope: unknown) => T;
const cloneInto = (globalThis as { cloneInto?: CloneInto }).cloneInto;

/** Creates the Rubber Band pitch-shift worklet node, loading the processor and
 * WASM from the extension.
 *
 * Rejects after a timeout: pages whose CSP lacks `wasm-unsafe-eval` block the
 * WASM compile inside the worklet scope, and the ready handshake never
 * arrives — callers fall back to "Pitch not available". */
export async function createStretchNode(
  ctx: BaseAudioContext,
  timeoutMs = 8000,
): Promise<StretchNode> {
  const [wasmBytes] = await Promise.all([
    loadWasmBytes(),
    registered.has(ctx)
      ? Promise.resolve()
      : ctx.audioWorklet
          .addModule(browser.runtime.getURL('/worklets/rubberband-worklet.js'))
          .then(() => void registered.add(ctx)),
  ]);

  const processorOptions = { wasmBytes };
  const node = new AudioWorkletNode(ctx, 'note-by-note-rubberband', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: cloneInto ? cloneInto(processorOptions, window) : processorOptions,
  }) as StretchNode;

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('rubberband worklet timed out')),
      timeoutMs,
    );
    node.port.onmessage = (e) => {
      if (e.data?.type === 'ready') {
        clearTimeout(timer);
        node.port.onmessage = null;
        resolvePromise();
      } else if (e.data?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(`rubberband worklet failed: ${e.data.error}`));
      }
    };
    node.onprocessorerror = () => {
      clearTimeout(timer);
      reject(new Error('rubberband worklet failed'));
    };
  });

  // Adapt the StretchNode surface to the processor's port protocol. Speed is
  // applied via el.playbackRate upstream, so only the net pitch matters here;
  // rate/tonalityHz/active have no Rubber Band analogue and are ignored (the
  // pipeline's smart bypass handles the neutral-pitch case).
  node.schedule = (seg) => {
    node.port.postMessage({ type: 'schedule', semitones: seg.semitones ?? 0 });
    return Promise.resolve();
  };
  node.configure = (cfg) => {
    // Engine choice and formant preservation are independent worklet flags.
    // Only send the field this call concerns, so e.g. a formant-only configure
    // doesn't reset the engine: a blockMs request is the pipeline's low-latency
    // mode → R2 "Faster", otherwise the default R3 "Finer" (best quality).
    const msg: {
      type: 'configure';
      highQuality?: boolean;
      formantPreserved?: boolean;
    } = { type: 'configure' };
    if (cfg.blockMs !== undefined || cfg.preset !== undefined) {
      msg.highQuality = !cfg.blockMs;
    }
    if (cfg.formantPreserved !== undefined) {
      msg.formantPreserved = cfg.formantPreserved;
    }
    node.port.postMessage(msg);
    return Promise.resolve();
  };
  node.stop = () => {
    node.port.postMessage({ type: 'stop' });
    return Promise.resolve();
  };
  node.start = () => Promise.resolve();
  node.latency = () => Promise.resolve(0);
  node.setUpdateInterval = () => {};

  return node;
}
