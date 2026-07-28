import { BtcChordEngine } from './btc-chords';
import type { ChordChart } from '../../../core/model/types';
import { session } from '../../../core/state/session.svelte';

/** One analysis run at a time: idle (chart or empty) → confirming (inline
 * "from the start or from here?") → loading (BTC model) → analyzing. */
export type ChordsPhase = 'idle' | 'confirming' | 'loading' | 'analyzing';

/** No PCM for this long while analyzing = the run is dead (playback never
 * started, the jump never landed, or the engine tap silently failed). */
const PCM_TIMEOUT_MS = 8000;

/** Panel-side chord/key analysis: the run workflow, the chart, and the chord
 * under the playhead. The BTC model runs here (side panel, extension CSP) over
 * PCM streamed from the engine. Chords are track-scoped — swapped in/out by
 * track-sync like markers. */
class ChordsStore {
  /** Master switch. Off hides the section body; the chart is kept. */
  enabled = $state(false);
  phase = $state<ChordsPhase>('idle');
  /** The chart shown and persisted — one analysis run per song, no merging. */
  chart = $state<ChordChart | null>(null);
  /** Transient "model failed to load" hint under the Analyze button. */
  loadError = $state(false);

  /** Media time the current run started at (0 when started from the top). The
   * auto-stop watcher arms near it, so the engine's delayed jump echo can't be
   * mistaken for a user seek. Plain field: read only from a reactive effect. */
  startT = 0;
  /** performance.now() of the last PCM batch — the watchdog reads this to
   * catch a run that never receives audio. Non-reactive on purpose. */
  lastPcmAt = 0;

  #engine: BtcChordEngine | null = null;
  #persistTimer: ReturnType<typeof setTimeout> | undefined;
  #loadErrorTimer: ReturnType<typeof setTimeout> | undefined;
  /** Wall-clock watchdog while analyzing — an interval rather than a reactive
   * effect, so a run that produces no events at all still gets stopped. */
  #watchdog: ReturnType<typeof setInterval> | undefined;
  /** First-PCM-batch log gate for the current run. */
  #pcmSeen = false;

  /** Called by track-sync to persist the current chart with the track. */
  onPersist: (() => void) | null = null;

  get hasChart(): boolean {
    return !!this.chart && this.chart.segments.length > 0;
  }

  #ensureEngine(): BtcChordEngine {
    if (!this.#engine) {
      this.#engine = new BtcChordEngine({
        onChart: (chart) => {
          this.chart = chart;
          this.#schedulePersist();
        },
        getDuration: () => session.duration,
      });
    }
    return this.#engine;
  }

  /** Master switch. Turning off ends any run in progress and hides the body,
   * but keeps the analyzed chords — only the trash button deletes them. */
  setEnabled(on: boolean) {
    this.#log(`switch ${on ? 'on' : 'off'}`, { phase: this.phase, hasChart: this.hasChart });
    if (!on) this.#abortRun();
    this.enabled = on;
    this.phase = 'idle';
    this.#persistNow();
  }

  /** Analyze clicked — show the inline start-position choice. */
  requestAnalyze() {
    if (this.phase === 'idle') this.phase = 'confirming';
  }

  cancelAnalyze() {
    if (this.phase === 'confirming') this.phase = 'idle';
  }

  /** Confirmed: discard the old chart, load the model, and only once it's
   * ready start playback — so no audio is missed while loading. `fromStart`
   * jumps to 0:00 first (the full-song run); otherwise the run begins at the
   * current playhead and only covers the rest of the song. */
  async confirmAnalyze(fromStart: boolean) {
    if (this.phase !== 'confirming' || (fromStart && session.sourceChanging)) {
      this.#log('analyze ignored', {
        phase: this.phase,
        sourceChanging: session.sourceChanging,
      });
      return;
    }
    this.#log(`analyze confirmed (${fromStart ? 'from start' : 'from here'}) — loading model`);
    this.phase = 'loading';
    this.loadError = false;
    this.chart = null;
    this.#persistNow();
    try {
      await this.#ensureEngine().ready();
    } catch (err) {
      console.error('[note-by-note] chords: model load failed', err);
      if (this.phase === 'loading') {
        this.phase = 'idle';
        this.#flashLoadError();
      }
      return;
    }
    // The load takes seconds — bail if the user switched off, the track
    // changed, or the port dropped in the meantime.
    if (this.phase !== 'loading') {
      this.#log('analyze aborted during model load', { phase: this.phase });
      return;
    }
    this.#ensureEngine().start();
    session.send({ type: 'chordDetect', on: true });
    if (fromStart) {
      session.jumpStart();
      this.startT = 0;
    } else {
      this.startT = session.t;
    }
    session.play();
    this.#log('model ready — analyzing', { startT: this.startT, duration: session.duration });
    this.lastPcmAt = performance.now();
    this.#pcmSeen = false;
    this.phase = 'analyzing';
    this.#startWatchdog();
  }

  /** End the run, keeping whatever was analyzed so far. */
  stopAnalysis(reason: 'manual' | 'pause' | 'seek' | 'ended' | 'error') {
    if (this.phase !== 'analyzing') return;
    this.#log(`analysis stopped (${reason})`, {
      t: session.t,
      playing: session.playing,
      coverage: this.chart?.coverage ?? 0,
      segments: this.chart?.segments.length ?? 0,
    });
    this.#abortRun();
    this.phase = 'idle';
    this.#persistNow();
  }

  /** Sync from a fresh engine snapshot (reconnect / tab switch). A run can't
   * survive a panel reload, so a stale engine-side tap gets shut off;
   * conversely a dead tap while we think we're analyzing ends the run. */
  syncActive(active: boolean) {
    if (active && this.phase !== 'analyzing') {
      this.#log('engine tap is on with no run in progress — turning it off');
      session.send({ type: 'chordDetect', on: false });
    } else if (!active && this.phase === 'analyzing') {
      this.#log('engine tap went away mid-run — stopping');
      this.stopAnalysis('error');
    }
  }

  /** The port dropped — no PCM is coming; end any run in flight. */
  onDisconnect() {
    if (this.phase === 'analyzing' || this.phase === 'loading') {
      this.#log('port disconnected mid-run — stopping', { phase: this.phase });
      this.#stopWatchdog();
      this.#engine?.stop();
      this.phase = 'idle';
      this.#persistNow();
    }
  }

  /** Feed a PCM batch from the engine to the model. */
  pushPcm(samples: number[], sampleRate: number, t: number, speed: number) {
    this.lastPcmAt = performance.now();
    if (!this.#pcmSeen && this.phase === 'analyzing') {
      this.#pcmSeen = true;
      this.#log('first PCM batch received', { t, sampleRate, speed });
    }
    this.#engine?.pushPcm(samples, sampleRate, t, speed);
  }

  /** Delete the analyzed chords for this track (and the persisted copy). */
  clear() {
    this.chart = null;
    this.#persistNow();
  }

  /** Track-sync swap-in: seed from the per-track cache. Records saved before
   * the switch was persisted show their chart (switch on). */
  load(chart: ChordChart | null, enabled?: boolean) {
    clearTimeout(this.#persistTimer);
    if (this.phase === 'analyzing' || this.phase === 'loading') {
      this.#log('track changed mid-run — aborting', { phase: this.phase });
      this.#abortRun();
    }
    this.chart = chart;
    this.phase = 'idle';
    this.enabled = enabled ?? (!!chart && chart.segments.length > 0);
  }

  /** Stop the model, the engine-side PCM tap, and the watchdog. */
  #abortRun() {
    this.#stopWatchdog();
    this.#engine?.stop();
    session.send({ type: 'chordDetect', on: false });
  }

  /** Persist immediately — the switch and the trash button must not sit
   * behind the debounce. */
  #persistNow() {
    clearTimeout(this.#persistTimer);
    this.onPersist?.();
  }

  #schedulePersist() {
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => this.onPersist?.(), 2000);
  }

  #flashLoadError() {
    this.loadError = true;
    clearTimeout(this.#loadErrorTimer);
    this.#loadErrorTimer = setTimeout(() => (this.loadError = false), 4000);
  }

  /** Stop a run that stopped receiving PCM (playback never started, the jump
   * never landed, or the engine-side tap died without an event). */
  #startWatchdog() {
    this.#stopWatchdog();
    this.#watchdog = setInterval(() => {
      if (this.phase !== 'analyzing') {
        this.#stopWatchdog();
        return;
      }
      const silentMs = performance.now() - this.lastPcmAt;
      if (silentMs > PCM_TIMEOUT_MS) {
        this.#log(`no PCM for ${Math.round(silentMs)} ms — giving up`, {
          t: session.t,
          playing: session.playing,
          connection: session.connection,
        });
        this.stopAnalysis('error');
      }
    }, 1000);
  }

  #stopWatchdog() {
    clearInterval(this.#watchdog);
    this.#watchdog = undefined;
  }

  #log(msg: string, extra?: Record<string, unknown>) {
    if (extra) console.info(`[note-by-note] chords: ${msg}`, extra);
    else console.info(`[note-by-note] chords: ${msg}`);
  }
}

export const chords = new ChordsStore();
