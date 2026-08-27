// The controller is a composition root: it imports each feature's engine-side
// scheduler / analysis (loop, sequence, count-in, speed BPM, chords PCM tap)
// and drives them from its central handle() switch. This core→feature import
// is intentional (the plan's dependency-direction rule); features never import
// the controller.
import { attachAudio } from '@/core/engine/attach-audio';
import { detectBpmFromAnalyser } from '@/features/speed/engine/detect-bpm';
import { detectTuningFromAnalyser, TUNING_FFT_SIZE } from '@/features/pitch/engine/detect-tuning';
import type { PcmTap } from '@/features/chords/engine/pcm-tap';
import type { AudioPipeline } from '@/core/audio/pipeline';
import {
  findBestMedia,
  watchForMedia,
  watchSourceChange,
} from '@/core/engine/media-detect';
import { MediaEngine } from '@/core/engine/media-engine';
import { LoopScheduler } from '@/features/loops/engine/loop-scheduler';
import { SequenceScheduler } from '@/features/snippets/engine/sequence-scheduler';
import { CountIn, type CountInConfig } from '@/features/count-in/engine/count-in';
import { Metronome } from '@/features/count-in/engine/metronome';
import { UI_PORT, type EngineCommand, type EngineEvent } from '@/core/messaging/protocol';
import { acceptPorts, type TypedPort } from '@/core/messaging/ports';
import { DEFAULT_PARAMS } from '@/core/model/defaults';
import type { ConnectionState } from '@/core/model/types';

declare global {
  interface Window {
    __noteByNote?: boolean;
    /** Diagnostics for tests/debugging (isolated world only). */
    __noteByNoteDebug?: {
      state(): string;
      pitchMode(): string;
      /** Dominant frequency (Hz) of the processed output via autocorrelation. */
      outputPitch(): number;
      outputRms(): number;
      /** Output level (dB) near `hz`; −999 when silent/no pipeline. */
      bandDb(hz: number): number;
      params(): unknown;
    };
  }
}

/** The E2E harness is the only consumer of `__noteByNoteDebug`, so it stays out
 * of release builds. Nothing hostile could reach it either way — the content
 * script runs in an isolated world — but shipping it earns nothing. */
const EXPOSE_DEBUG = import.meta.env.DEV || import.meta.env.MODE === 'testing';

/** Autocorrelation pitch estimate — good enough to verify a sine tone. */
function estimatePitch(analyser: AnalyserNode, sampleRate: number): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  const n = buf.length;
  let bestLag = 0;
  let bestCorr = 0;
  const minLag = Math.floor(sampleRate / 2000);
  const maxLag = Math.floor(sampleRate / 60);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) corr += buf[i] * buf[i + lag];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return bestLag ? sampleRate / bestLag : 0;
}

function rms(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/** Level (dB) of a tone at `hz`: Hann-windowed Goertzel over the analyser's
 * current time-domain window. Unlike getFloatFrequencyData this has no
 * temporal smoothing, so tests read effect changes immediately. */
function bandDb(analyser: AnalyserNode, sampleRate: number, hz: number): number {
  const n = analyser.fftSize;
  const buf = new Float32Array(n);
  analyser.getFloatTimeDomainData(buf);
  const omega = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    const s0 = buf[i] * w + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(omega);
  const im = s2 * Math.sin(omega);
  // Hann coherent gain is 0.5 → tone amplitude = 4·|X|/n.
  const amp = (4 * Math.sqrt(re * re + im * im)) / n;
  return amp > 1e-10 ? 20 * Math.log10(amp) : -999;
}

type UiPort = TypedPort<EngineCommand, EngineEvent>;

export class Controller {
  state: ConnectionState = 'detecting';
  engine: MediaEngine | null = null;
  loop: LoopScheduler | null = null;
  seq: SequenceScheduler | null = null;
  countIn: CountIn | null = null;
  metronome: Metronome | null = null;
  /** Current count-in config, kept across re-attaches (schedulers are rebuilt). */
  #countInConfig: CountInConfig = { beats: 4, bpm: 100, beep: true };
  ports = new Set<UiPort>();
  /** Whether the DSP chain is attached ('direct') or blocked ('unavailable'). */
  pitchMode: 'pending' | 'direct' | 'unavailable' = 'pending';
  /** The attached pipeline (analyser tap for BPM/tuning detection); null when blocked. */
  #pipeline: AudioPipeline | null = null;
  /** True while a BPM detection run is in flight (blocks overlapping runs). */
  #detectingBpm = false;
  /** True while a reference-tuning detection run is in flight. */
  #detectingTuning = false;
  /** User intent: stream PCM to the panel for chord detection while on. */
  #chordEnabled = false;
  /** The silent PCM tap (lives on the pipeline), while streaming is active. */
  #pcmTap: PcmTap | null = null;
  /** State reported while connected & playing ('local-file' for the player page). */
  readonly connectedState: ConnectionState;
  #stopWatchdog: (() => void) | null = null;
  #disposeAudio: (() => void) | null = null;
  #unwatchSource: (() => void) | null = null;
  #unwatchMedia: (() => void) | null = null;
  #unacceptPorts: (() => void) | null = null;
  #lastHref = location.href;

  constructor(options?: { connectedState?: ConnectionState }) {
    this.connectedState = options?.connectedState ?? 'connected-direct';
  }

  begin() {
    this.#unacceptPorts = acceptPorts<EngineCommand, EngineEvent>(UI_PORT, (port) => {
      this.ports.add(port);
      port.onMessage((cmd) => this.handle(cmd));
      port.onDisconnect(() => this.ports.delete(port));
      port.send(this.snapshot());
    });

    if (EXPOSE_DEBUG) {
      window.__noteByNoteDebug = {
        state: () => this.state,
        pitchMode: () => this.pitchMode,
        outputPitch: () => 0,
        outputRms: () => 0,
        bandDb: () => -999,
        params: () => (this.engine ? JSON.parse(JSON.stringify(this.engine.params)) : null),
      };
    }

    this.#unwatchMedia = watchForMedia(() => this.evaluate());
    this.evaluate();
  }

  /** Full teardown for extension reload/update: without it an orphaned
   * instance keeps ticking, seeking, and re-writing playbackRate forever. */
  destroy() {
    try {
      this.#unacceptPorts?.();
    } catch {
      // Extension context already invalidated; the listener died with it.
    }
    this.#unacceptPorts = null;
    for (const port of this.ports) port.disconnect();
    this.ports.clear();
    this.#unwatchMedia?.();
    this.#unwatchMedia = null;
    this.#detach();
    delete window.__noteByNoteDebug;
  }

  broadcast(event: EngineEvent) {
    for (const port of this.ports) port.send(event);
  }

  #setState(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    this.broadcast({ type: 'state', state });
  }

  /** 'pending' reads as available so the panel doesn't flicker its effect
   * controls off and on again while the worklets load. */
  #setPitchMode(mode: Controller['pitchMode']) {
    if (this.pitchMode === mode) return;
    this.pitchMode = mode;
    this.broadcast({ type: 'dsp', available: mode !== 'unavailable' });
  }

  /** Picks (or re-picks) the media element to control. */
  evaluate() {
    const best = findBestMedia();
    if (!best) {
      if (!this.engine) this.#setState('detecting');
      return;
    }
    const current = this.engine?.el;
    if (current === best) {
      this.#syncPlayState();
      return;
    }
    // Replace only when clearly better: none yet, current detached/ended,
    // or the newcomer is playing while the current one is not.
    const replace =
      !current ||
      !current.isConnected ||
      !current.currentSrc ||
      (!best.paused && current.paused);
    if (!replace) return;

    this.#attach(best);
  }

  #attach(el: HTMLMediaElement) {
    // Carry the live settings across the swap. Sites replace the element mid-page
    // (YouTube does it for pre-rolls and quality changes), and a fresh engine on
    // DEFAULT_PARAMS would silently reset the user's pitch/speed — and broadcast
    // that reset over whatever the panel had just applied. Whether a *new track*
    // should start clean is the panel's call (auto reset / remember / carry over),
    // not something an element swap gets to decide.
    const carried = this.engine
      ? { params: structuredClone(this.engine.params), volume: this.engine.volume }
      : null;
    this.#detach();
    const engine = new MediaEngine(el, {
      onTime: (t, playing) => {
        this.broadcast({ type: 'time', t, playing });
        this.#pollNavigation();
      },
      onMediaInfo: (info) => this.broadcast({ type: 'media', media: info }),
      onParams: (params) =>
        this.broadcast({ type: 'params', params: structuredClone(params) }),
      onVolume: (volume) => this.broadcast({ type: 'volume', volume }),
    });
    if (carried) {
      engine.volume = carried.volume;
      // Through patchParams, not a field write: it syncs the element's rate and
      // preservesPitch flags to the carried values (the chain picks them up in
      // #attachChain) and echoes them, so the panel mirror can't drift.
      engine.patchParams(carried.params);
    }
    this.engine = engine;
    this.metronome = new Metronome();
    this.countIn = new CountIn(
      this.metronome,
      (countdown) => this.broadcast({ type: 'countdown', countdown }),
      // Beeps only in direct/local mode — a page-side click in capture mode
      // would be re-captured and returned pitch-shifted.
      () => this.pitchMode === 'direct',
    );
    this.countIn.setConfig(this.#countInConfig);
    this.loop = new LoopScheduler(engine, this.countIn, {
      onLoop: (loop) => this.broadcast({ type: 'loop', loop }),
    });
    this.seq = new SequenceScheduler(engine, this.countIn, {
      onSeq: (seq) => this.broadcast({ type: 'seq', seq }),
    });
    // Sequence takes precedence over plain loops on the same tick.
    engine.onTick = (t) => {
      if (!this.seq?.tick(t)) this.loop?.tick(t);
    };
    this.#unwatchSource = watchSourceChange(el, () => {
      // SPA swapped the source: new track in the same element. Tell the panel
      // its track-scoped state is stale before anything can seek from it, and
      // drop a pending scrub preview so its timer can't pause the new track.
      this.broadcast({ type: 'source-changing' });
      engine.cancelScrub();
      this.loop?.clear();
      this.seq?.stop();
      // PCM keeps streaming across the src swap; the media-time jump makes the
      // panel reset its analysis window for the new track.
      engine.emitMediaInfo();
    });

    el.addEventListener('play', this.#onPlayState);
    el.addEventListener('pause', this.#onPlayState);

    this.#syncPlayState();
    this.broadcast(this.snapshot());
    void this.#attachChain(engine);
  }

  /** Builds the DSP chain, honoring the CORS/DRM pre-flight. */
  async #attachChain(engine: MediaEngine) {
    const result = await attachAudio(engine.el, () => {
      // CORS taint: element is silenced until reload — surface it.
      this.#setPitchMode('unavailable');
      this.broadcast({ type: 'error', code: 'cors-silence' });
      this.#syncPlayState();
    });
    if (this.engine !== engine) {
      // Replaced while awaiting: tear down what attachAudio built for the old
      // element, or its watchdog keeps running against a disconnected graph
      // and eventually broadcasts a bogus 'cors-silence' for the new session.
      if (result.ok) {
        result.stopWatchdog();
        result.pipeline.dispose();
      }
      result.dispose?.();
      return;
    }
    this.#disposeAudio = result.dispose ?? null;
    if (result.ok) {
      engine.chain = result.pipeline;
      this.#pipeline = result.pipeline;
      this.#stopWatchdog = result.stopWatchdog;
      this.#setPitchMode('direct');
      // Route volume/effects through the chain from the current state.
      engine.chain.applyParams(engine.params);
      engine.chain.setVolume(engine.volume);
      // Resume PCM streaming on the fresh pipeline if the toggle is on.
      if (this.#chordEnabled) void this.#startPcm();
      const { pipeline } = result;
      if (EXPOSE_DEBUG) {
        window.__noteByNoteDebug = {
          state: () => this.state,
          pitchMode: () => this.pitchMode,
          outputPitch: () => estimatePitch(pipeline.outputAnalyser, pipeline.ctx.sampleRate),
          outputRms: () => rms(pipeline.outputAnalyser),
          bandDb: (hz) => bandDb(pipeline.outputAnalyser, pipeline.ctx.sampleRate, hz),
          params: () => JSON.parse(JSON.stringify(engine.params)),
        };
      }
    } else {
      this.#setPitchMode('unavailable');
      this.#pipeline = null;
      // No chain will ever own volume for this element — element fallback is
      // safe; apply what the user staged while the chain was loading.
      engine.allowElementVolume = true;
      engine.flushVolume();
      this.broadcast({
        type: 'error',
        code: result.reason === 'worklet-failed' ? 'worklet-failed' : 'cors-silence',
        detail: result.reason,
      });
    }
    this.#syncPlayState();
  }

  #onPlayState = () => this.#syncPlayState();

  #syncPlayState() {
    if (!this.engine) return;
    if (!this.engine.playing) {
      this.#setState('media-paused');
    } else {
      this.#setState(
        this.pitchMode === 'unavailable' ? 'pitch-unavailable' : this.connectedState,
      );
    }
  }

  #detach() {
    if (!this.engine) return;
    this.engine.el.removeEventListener('play', this.#onPlayState);
    this.engine.el.removeEventListener('pause', this.#onPlayState);
    this.#stopWatchdog?.();
    this.#stopWatchdog = null;
    this.#disposeAudio?.();
    this.#disposeAudio = null;
    this.#unwatchSource?.();
    this.loop?.dispose();
    this.seq?.dispose();
    this.countIn?.dispose();
    this.metronome?.dispose();
    this.engine.dispose();
    this.engine = null;
    this.loop = null;
    this.seq = null;
    this.countIn = null;
    this.metronome = null;
    this.#setPitchMode('pending');
    this.#pipeline = null;
    // A run in flight aborts via #abortDetect (engine identity change); flip the
    // flag now so its 'bpm' completion event still reports detecting:false.
    this.#detectingBpm = false;
    this.#detectingTuning = false;
    // Stop PCM streaming — the pipeline (and its tap) is gone. #chordEnabled
    // persists so streaming resumes when the next chain attaches.
    this.#stopPcm();
  }

  /** Measure the tempo of the playing audio and report the base (1×) bpm.
   * Direct/local only — the analyser tap and playbackRate both live here. */
  async #detectBpm() {
    const engine = this.engine;
    if (
      this.#detectingBpm ||
      this.pitchMode !== 'direct' ||
      !engine ||
      !engine.playing ||
      !this.#pipeline
    ) {
      return;
    }
    this.#detectingBpm = true;
    this.broadcast({ type: 'bpm', detecting: true, bpm: null });
    let bpm: number | null = null;
    try {
      const est = await detectBpmFromAnalyser(
        this.#pipeline.analyser,
        { durationMs: 10000, outRate: 100 },
        () => this.#abortDetect(engine),
      );
      // The analyser is downstream of el.playbackRate, so it hears the audible
      // (sped) tempo; divide back to the stored 1× base — same as tap-tempo.
      if (est.bpm != null && !this.#abortDetect(engine)) {
        bpm = est.bpm / (engine.el.playbackRate || 1);
      }
    } finally {
      this.#detectingBpm = false;
      this.broadcast({ type: 'bpm', detecting: false, bpm });
    }
  }

  /** Measure the recording's reference A4 and report it (Hz). Direct/local
   * only — the analyser tap lives here. The tap is pre-stretch and the element
   * plays with preservesPitch, so speed/transpose don't colour the reading. */
  async #detectTuning() {
    const engine = this.engine;
    if (
      this.#detectingTuning ||
      this.pitchMode !== 'direct' ||
      !engine ||
      !engine.playing ||
      !this.#pipeline
    ) {
      console.debug('[note-by-note] tuning: detect skipped', {
        inFlight: this.#detectingTuning,
        pitchMode: this.pitchMode,
        playing: engine?.playing ?? null,
        hasPipeline: !!this.#pipeline,
      });
      return;
    }
    this.#detectingTuning = true;
    this.broadcast({ type: 'tuning', detecting: true, hz: null });
    const t0 = performance.now();
    const pipeline = this.#pipeline;
    console.debug('[note-by-note] tuning: detect start', {
      sampleRate: pipeline.ctx.sampleRate,
      fftSize: TUNING_FFT_SIZE,
      durationMs: 4000,
      playbackRate: engine.el.playbackRate,
      mediaTime: Number(engine.el.currentTime.toFixed(2)),
      currentTuning: { ...engine.params.tuning },
    });
    let hz: number | null = null;
    try {
      const est = await detectTuningFromAnalyser(
        pipeline.analyser,
        {
          durationMs: 4000,
          onFrame: ({ index, atMs, loudestDb }) =>
            console.debug(
              `[note-by-note] tuning: frame ${index} at ${atMs.toFixed(0)} ms, loudest ${loudestDb.toFixed(1)} dB`,
            ),
        },
        () => this.#abortDetect(engine),
      );
      const aborted = this.#abortDetect(engine);
      const d = est.details;
      console.debug('[note-by-note] tuning: estimate', {
        hz: est.hz,
        confidence: Number(est.confidence.toFixed(3)),
        accepted: d.accepted,
        aborted,
        frames: `${d.usedFrames}/${d.frames} used`,
        devCents: Number(d.devCents.toFixed(1)),
        peakCents: d.peakCents,
        runnerUpCents: d.runnerUpCents,
        peakScore: Number(d.peakScore.toFixed(1)),
        meanScore: Number(d.meanScore.toFixed(1)),
        runnerUpScore: Number(d.runnerUpScore.toFixed(1)),
        elapsedMs: Math.round(performance.now() - t0),
      });
      if (est.hz != null && !aborted) hz = est.hz;
    } catch (err) {
      console.warn('[note-by-note] tuning: detection failed', err);
    } finally {
      this.#detectingTuning = false;
      console.debug('[note-by-note] tuning: result', { hz });
      this.broadcast({ type: 'tuning', detecting: false, hz });
    }
  }

  /** True once detection should give up: element/pipeline swapped or paused. */
  #abortDetect(engine: MediaEngine): boolean {
    return (
      this.engine !== engine ||
      this.pitchMode !== 'direct' ||
      this.#pipeline === null ||
      !engine.playing
    );
  }

  /** Toggle PCM streaming for panel-side chord detection. Direct/local only —
   * the tap lives on the pipeline. Intent persists across track changes; the
   * panel owns the model, chart, and detecting state. */
  #chordDetect(on: boolean) {
    console.debug(`[note-by-note] chords: engine tap ${on ? 'on' : 'off'} requested`);
    this.#chordEnabled = on;
    if (on) void this.#startPcm();
    else this.#stopPcm();
  }

  async #startPcm() {
    const engine = this.engine;
    if (this.#pcmTap) return; // already streaming
    if (this.pitchMode !== 'direct' || !engine || !this.#pipeline) {
      console.warn('[note-by-note] chords: PCM tap unavailable', {
        pitchMode: this.pitchMode,
        hasEngine: !!engine,
        hasPipeline: !!this.#pipeline,
      });
      return;
    }
    let tap: PcmTap;
    try {
      tap = await this.#pipeline.attachPcmTap();
    } catch (err) {
      // Worklet load failed — chord detection unavailable; audio is untouched.
      console.warn('[note-by-note] chords: PCM tap worklet failed to attach', err);
      this.#chordEnabled = false;
      return;
    }
    // State may have changed while the worklet loaded.
    if (!this.#chordEnabled || this.engine !== engine || !this.#pipeline) {
      console.debug('[note-by-note] chords: PCM tap start abandoned (state changed)');
      tap.stop();
      return;
    }
    console.debug('[note-by-note] chords: PCM tap streaming');
    this.#pcmTap = tap;
    const sampleRate = this.#pipeline.ctx.sampleRate;
    tap.onPcm((samples) => {
      if (this.engine) {
        this.broadcast({
          type: 'pcm',
          samples: Array.from(samples),
          sampleRate,
          t: this.engine.t,
          speed: this.engine.el.playbackRate,
        });
      }
    });
    tap.start();
  }

  #stopPcm() {
    this.#pcmTap?.stop();
    this.#pcmTap = null;
  }

  /** SPA URL changes (yt navigation) don't reload the page — detect via href. */
  #pollNavigation() {
    if (location.href === this.#lastHref) return;
    this.#lastHref = location.href;
    // The element still reports the OLD track's duration/title here — emitting
    // media info now would key the panel to a mixed old/new identity. Announce
    // the transition instead; 'loadstart'/'durationchange' emit the real info.
    this.broadcast({ type: 'source-changing' });
  }

  snapshot(): EngineEvent {
    return {
      type: 'snapshot',
      state: this.state,
      media: this.engine?.mediaInfo() ?? null,
      params: structuredClone(this.engine?.params ?? DEFAULT_PARAMS),
      volume: this.engine?.volume ?? 1,
      loop: this.loop?.state ?? { mode: null, active: false, countIn: false, lap: 0 },
      seq: this.seq?.state() ?? {
        running: false,
        activeSnippetId: null,
        lap: 0,
        totalLaps: 0,
        loopAll: false,
      },
      t: this.engine?.t ?? 0,
      playing: this.engine?.playing ?? false,
      chordActive: this.#chordEnabled,
      dspAvailable: this.pitchMode !== 'unavailable',
    };
  }

  handle(cmd: EngineCommand) {
    const { engine, loop, seq, countIn } = this;
    switch (cmd.type) {
      case 'hello':
        this.evaluate();
        this.broadcast(this.snapshot());
        break;
      case 'transport':
        if (!engine) break;
        if (cmd.op === 'play' || cmd.op === 'toggle') {
          // The transport Play button never counts in — the count-in is for
          // loop restarts and "play from here", not plain resume. Pressing
          // during a count-in still aborts it (DAW-style); a playing element
          // toggles to pause; otherwise just play.
          if (countIn?.active) countIn.cancel();
          else if (engine.playing) {
            if (cmd.op === 'toggle') engine.pause();
          } else engine.play();
        } else if (cmd.op === 'pause') {
          countIn?.cancel();
          engine.pause();
        } else if (cmd.op === 'jumpStart') {
          countIn?.cancel();
          engine.jumpStart();
        } else if (cmd.op === 'skip') {
          countIn?.cancel();
          engine.skip(cmd.value ?? 5);
        }
        break;
      case 'seek':
        countIn?.cancel();
        engine?.seek(cmd.t);
        break;
      case 'playFrom':
        // "Play from here": when the count-in toggle is on, count in from cmd.t
        // (run() pauses then seeks, so it works whether the element was paused
        // or already playing). Otherwise it's a plain seek-and-play. A running
        // sequence owns the transport — just relocate within it.
        if (!engine) break;
        if (countIn && loop?.state.countIn && !seq?.running) {
          countIn.run(engine, cmd.t, () => engine.play());
        } else {
          countIn?.cancel();
          engine.seek(cmd.t);
          if (!engine.playing) engine.play();
        }
        break;
      case 'scrub':
        countIn?.cancel();
        engine?.scrub(cmd.t, cmd.previewMs);
        break;
      case 'params':
        engine?.patchParams(cmd.patch);
        break;
      case 'detectBpm':
        void this.#detectBpm();
        break;
      case 'detectTuning':
        void this.#detectTuning();
        break;
      case 'chordDetect':
        this.#chordDetect(cmd.on);
        break;
      case 'volume':
        engine?.setVolume(cmd.volume);
        break;
      case 'loop.set':
        countIn?.cancel();
        seq?.stop();
        loop?.setRange(cmd.startT, cmd.endT);
        break;
      case 'loop.toggle':
        countIn?.cancel();
        if (cmd.on) seq?.stop();
        loop?.toggle(cmd.on);
        break;
      case 'loop.song':
        countIn?.cancel();
        if (cmd.on) seq?.stop();
        loop?.setSong(cmd.on);
        break;
      case 'loop.countIn':
        loop?.setCountIn(cmd.on);
        break;
      case 'loop.clear':
        loop?.clear();
        break;
      case 'seq.start':
        loop?.clear();
        seq?.start(cmd.snippets, cmd.fromSnippetId, cmd.loopAll);
        break;
      case 'seq.update':
        seq?.update(cmd.snippets, cmd.loopAll);
        break;
      case 'seq.stop':
        seq?.stop();
        break;
      case 'settings':
        engine?.chain?.setLowLatency(cmd.lowLatency);
        engine?.chain?.setFormantPreserved(cmd.formantPreserved);
        this.#countInConfig = {
          beats: cmd.countInBeats,
          bpm: cmd.countInBpm,
          beep: cmd.countInBeep,
        };
        countIn?.setConfig(this.#countInConfig);
        break;
    }
  }
}

