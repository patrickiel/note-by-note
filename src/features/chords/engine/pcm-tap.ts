/** Main-thread factory for the PCM analysis tap (AudioWorklet).
 *
 * A silent branch off the raw source that streams mono PCM (at the context
 * sample rate) to `onPcm` while started. The engine forwards those batches to
 * the side panel, where the BTC chord model runs. Rejects on load
 * failure/timeout — chord detection is simply unavailable; audio is untouched.
 * Pure JS from an extension URL, so it loads even where a page's CSP blocks
 * WASM. Modeled on createVocalReducer. */
export interface PcmTap {
  /** Begin/stop streaming PCM (the node stays resident either way). */
  start(): void;
  stop(): void;
  /** Register the PCM-batch callback (mono, context sample rate). */
  onPcm(cb: (samples: Float32Array) => void): void;
  dispose(): void;
}

/** addModule is per-context; contexts are reused across reattach. */
const registered = new WeakSet<BaseAudioContext>();

export async function createPcmTap(
  ctx: BaseAudioContext,
  source: AudioNode,
  timeoutMs = 4000,
): Promise<PcmTap> {
  if (!registered.has(ctx)) {
    await ctx.audioWorklet.addModule(browser.runtime.getURL('/worklets/pcm-tap-worklet.js'));
    registered.add(ctx);
  }

  const node = new AudioWorkletNode(ctx, 'note-by-note-pcm-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pcm tap worklet timed out')), timeoutMs);
    node.port.onmessage = (e) => {
      if (e.data?.type === 'ready') {
        clearTimeout(timer);
        resolve();
      }
    };
    node.onprocessorerror = () => {
      clearTimeout(timer);
      reject(new Error('pcm tap worklet failed'));
    };
  });

  let onPcmCb: ((samples: Float32Array) => void) | null = null;
  node.port.onmessage = (e) => {
    if (e.data?.type === 'pcm') onPcmCb?.(e.data.samples as Float32Array);
  };

  // Silent sink: the node emits no audio, but needs a path to the destination
  // so the render quantum pulls its process().
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);

  return {
    start() {
      node.port.postMessage({ type: 'start' });
    },
    stop() {
      node.port.postMessage({ type: 'stop' });
    },
    onPcm(cb) {
      onPcmCb = cb;
    },
    dispose() {
      node.port.postMessage({ type: 'dispose' });
      try {
        source.disconnect(node);
      } catch {
        // already severed by the pipeline
      }
      node.disconnect();
      sink.disconnect();
    },
  };
}
