/** Phase-aware STFT center-cut vocal reducer (AudioWorklet).
 *
 * Per frequency bin the worklet removes the component where L and R agree in
 * magnitude and phase — only inside the vocal band, so bass, drums and panned
 * material survive and the output stays stereo (see center-cut-dsp.ts).
 *
 * The worklet path adds one FFT frame (~93 ms) of latency, so the composite
 * routes through a zero-latency bypass whenever the amount is 0 (power off,
 * panel off, slider at zero — pipeline.ts sends 0 for all three). The worklet
 * stays connected while bypassed: its delay line keeps running (cheap
 * windowed passthrough, no FFT) so re-engagement never fades in from silence.
 */
export interface VocalReducer {
  input: AudioNode;
  output: AudioNode;
  setAmount(k: number): void;
  /** false = reduce (drop vocal), true = isolate (keep vocal). */
  setIsolate(on: boolean): void;
  dispose(): void;
}

const ACTIVE_EPS = 0.001;

/** addModule is per-context; attach-audio reuses contexts across reattach. */
const registered = new WeakSet<BaseAudioContext>();

/** Creates the center-cut worklet reducer. Rejects on load failure/timeout —
 * callers treat that like a stretch-worklet failure (dry audio keeps
 * playing). Pure JS from an extension URL, so unlike the stretch worklet it
 * loads even on pages whose CSP blocks WASM. */
export async function createVocalReducer(
  ctx: BaseAudioContext,
  timeoutMs = 4000,
): Promise<VocalReducer> {
  if (!registered.has(ctx)) {
    await ctx.audioWorklet.addModule(
      browser.runtime.getURL('/worklets/vocal-reducer-worklet.js'),
    );
    registered.add(ctx);
  }

  const node = new AudioWorkletNode(ctx, 'note-by-note-center-cut', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  });

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('vocal reducer worklet timed out')),
      timeoutMs,
    );
    node.port.onmessage = (e) => {
      if (e.data?.type === 'ready') {
        clearTimeout(timer);
        node.port.onmessage = null;
        resolvePromise();
      }
    };
    node.onprocessorerror = () => {
      clearTimeout(timer);
      reject(new Error('vocal reducer worklet failed'));
    };
  });

  const input = ctx.createGain();
  const wet = ctx.createGain();
  const bypass = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(wet);
  wet.connect(output);
  input.connect(bypass);
  bypass.connect(output);
  wet.gain.value = 0;
  bypass.gain.value = 1;

  const amountParam = node.parameters.get('amount')!;
  const isoParam = node.parameters.get('iso')!;
  let active = false;

  return {
    input,
    output,
    setAmount(k: number) {
      const clamped = Math.min(1, Math.max(0, k));
      const t = ctx.currentTime;
      amountParam.setTargetAtTime(clamped, t, 0.02);
      const wantActive = clamped > ACTIVE_EPS;
      if (wantActive !== active) {
        active = wantActive;
        wet.gain.setTargetAtTime(active ? 1 : 0, t, 0.03);
        bypass.gain.setTargetAtTime(active ? 0 : 1, t, 0.03);
      }
    },
    setIsolate(on: boolean) {
      isoParam.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02);
    },
    dispose() {
      node.port.postMessage({ type: 'dispose' });
      for (const n of [input, node, wet, bypass, output]) {
        n.disconnect();
      }
    },
  };
}
