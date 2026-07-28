import type { EffectChain } from '../engine/media-engine';
import type { EffectParams } from '../model/types';
// The pipeline is a composition root: it imports each feature's DSP stage
// factory and wires them into the fixed wet/dry graph order. This core→feature
// import is intentional (see the plan's dependency-direction rule) — features
// never import the pipeline.
import { createPcmTap, type PcmTap } from '../../features/chords/engine/pcm-tap';
import { createEqualizer, type Equalizer } from '../../features/eq/engine/equalizer';
import { createStretchNode, type StretchNode } from '../../features/pitch/engine/stretch';
import { createVocalReducer, type VocalReducer } from '../../features/vocal-reducer/engine/vocal-reducer';

const FADE = 0.03;

/** Net pitch shift the stretch worklet must apply, in semitones. */
export function netSemitones(params: EffectParams): number {
  const tuningOffset =
    12 * Math.log2(params.tuning.instrumentHz / params.tuning.trackHz);
  return (
    (params.transposeEnabled ? params.transpose : 0) +
    (params.pitchEnabled ? params.pitchCents / 100 + tuningOffset : 0)
  );
}

export interface AudioPipeline extends EffectChain {
  readonly ctx: AudioContext;
  /** Taps the raw source (CORS-silence watchdog). */
  readonly analyser: AnalyserNode;
  /** Taps the processed output (diagnostics, level metering). */
  readonly outputAnalyser: AnalyserNode;
  /** Lazily attach the silent PCM tap for chord/key detection (raw source).
   * Memoized — repeated calls return the same tap; disposed with the pipeline. */
  attachPcmTap(): Promise<PcmTap>;
}

/**
 * The shared wet/dry graph (all connection modes):
 *
 * source ─┬─ dryGain ──────────────────────────────────────────┬─ master ─ destination
 *         └─ wetIn ─ reducer ─┬─ stretch ─ stretchWet ─┬─ eq ──┘
 *         │                   └─ stretchBypass ────────┘
 *         └─ analyser (silence watchdog)
 *
 * dry⇄wet crossfade = Power toggle; stretch bypass = zero-latency path while
 * pitch is neutral (keeps A/V sync in the speed-only case).
 */
export async function buildPipeline(
  ctx: AudioContext,
  source: AudioNode,
  onParamsApplied?: (params: EffectParams) => void,
): Promise<AudioPipeline> {
  const dryGain = ctx.createGain();
  const wetIn = ctx.createGain();
  const stretchWet = ctx.createGain();
  const stretchBypass = ctx.createGain();
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const outputAnalyser = ctx.createAnalyser();
  outputAnalyser.fftSize = 4096;

  // Kick off the (async) reducer worklet load before wiring the dry route so
  // it overlaps with the stretch worklet load below.
  const reducerPromise = createVocalReducer(ctx);
  const eq: Equalizer = createEqualizer(ctx);

  // We own the source exclusively — drop routes left by earlier attempts.
  source.disconnect();

  // Dry route first: a MediaElementSource only sounds through explicit
  // connections, so the element must never wait on the (slow, CSP-blockable)
  // worklet load. Start fully dry; applyParams performs the first crossfade.
  dryGain.gain.value = 1;
  wetIn.gain.value = 0;
  stretchWet.gain.value = 0;
  stretchBypass.gain.value = 1;
  source.connect(dryGain);
  source.connect(analyser);
  dryGain.connect(master);
  master.connect(ctx.destination);
  master.connect(outputAnalyser);

  const stretchPromise = createStretchNode(ctx);
  let stretch: StretchNode;
  let reducer: VocalReducer;
  try {
    [stretch, reducer] = await Promise.all([stretchPromise, reducerPromise]);
  } catch (err) {
    // Leave the dry route in place — audio keeps playing unprocessed. The
    // sibling worklet may still be loading; tear it down whenever it settles.
    stretchPromise.then((s) => {
      s.disconnect();
      void s.stop();
    }, () => {});
    reducerPromise.then((r) => r.dispose(), () => {});
    eq.dispose();
    throw err;
  }

  source.connect(wetIn);
  wetIn.connect(reducer.input);
  reducer.output.connect(stretch);
  reducer.output.connect(stretchBypass);
  stretch.connect(stretchWet);
  stretchWet.connect(eq.input);
  stretchBypass.connect(eq.input);
  eq.output.connect(master);

  let stretchActive = false;
  let lowLatencyApplied = false;
  let formantApplied = false;
  let pcmTap: PcmTap | null = null;
  let pcmTapPromise: Promise<PcmTap> | null = null;

  return {
    ctx,
    analyser,
    outputAnalyser,

    attachPcmTap() {
      if (!pcmTapPromise) {
        pcmTapPromise = createPcmTap(ctx, source).then(
          (tap) => (pcmTap = tap),
          (err) => {
            pcmTapPromise = null; // allow a later retry
            throw err;
          },
        );
      }
      return pcmTapPromise;
    },

    applyParams(params: EffectParams) {
      const t = ctx.currentTime;
      const semitones = netSemitones(params);
      const wantStretch = params.power && Math.abs(semitones) > 0.001;

      // Power crossfade (dry ⇄ wet).
      dryGain.gain.setTargetAtTime(params.power ? 0 : 1, t, FADE);
      wetIn.gain.setTargetAtTime(params.power ? 1 : 0, t, FADE);

      // Smart bypass around the stretch worklet.
      stretchWet.gain.setTargetAtTime(wantStretch ? 1 : 0, t, FADE);
      stretchBypass.gain.setTargetAtTime(wantStretch ? 0 : 1, t, FADE);

      if (wantStretch) {
        void stretch.schedule({ active: true, rate: 1, semitones });
        stretchActive = true;
      } else if (stretchActive) {
        // Keep it running (cheap on silence) so re-engagement is instant.
        void stretch.schedule({ active: true, rate: 1, semitones: 0 });
        stretchActive = false;
      }

      reducer.setAmount(
        params.power && params.vocalReduceEnabled ? params.vocalReduce : 0,
      );
      reducer.setIsolate(params.vocalMode === 'isolate');
      eq.setEnabled(params.power && params.eq.enabled);
      eq.setGains(params.eq.gains);

      onParamsApplied?.(params);
    },

    setVolume(volume: number) {
      master.gain.setTargetAtTime(
        Math.min(1, Math.max(0, volume)),
        ctx.currentTime,
        0.02,
      );
    },

    /** Low latency mode: smaller STFT blocks, some quality loss. */
    setLowLatency(on: boolean) {
      if (on === lowLatencyApplied) return;
      lowLatencyApplied = on;
      void stretch.configure(
        on ? { blockMs: 30, intervalMs: 8 } : { preset: 'default' },
      );
    },

    /** "Natural vocals": preserve the formant envelope while pitch-shifting so
     * voices stay natural instead of chipmunky. Opt-in — it dulls tonal content
     * (see rubberband.worklet.ts). Rebuilds the stretcher, so guard on change. */
    setFormantPreserved(on: boolean) {
      if (on === formantApplied) return;
      formantApplied = on;
      void stretch.configure({ formantPreserved: on });
    },

    dispose() {
      // Before dropping the source's routes below, so the tap can cleanly
      // sever its own source→node edge.
      pcmTap?.dispose();
      // A tap load still in flight would otherwise resolve after teardown and
      // wire itself onto this dead graph — dispose it whenever it settles (same
      // in-flight-promise handling as the stretch/reducer catch above).
      pcmTapPromise?.then((tap) => tap.dispose(), () => {});
      const nodes = [dryGain, wetIn, stretchWet, stretchBypass, master, analyser, outputAnalyser];
      for (const node of nodes) {
        node.disconnect();
      }
      reducer.dispose();
      eq.dispose();
      stretch.disconnect();
      void stretch.stop();
      // A MediaElementSource is the element's only audio route once created —
      // bridge it back to the speakers or the element goes mute.
      source.disconnect();
      source.connect(ctx.destination);
    },
  };
}
