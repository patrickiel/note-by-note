import type { EngineCommand, EngineErrorCode, EngineEvent } from '../messaging/protocol';
import { clampSpeed, DEFAULT_PARAMS } from '../model/defaults';
import type {
  SnippetRuntime,
  ConnectionState,
  CountInProgress,
  EffectParams,
  LoopState,
  MediaInfo,
  SequenceState,
} from '../model/types';

const IDLE_LOOP: LoopState = { mode: null, active: false, countIn: false, lap: 0 };
const IDLE_SEQ: SequenceState = {
  running: false,
  activeSnippetId: null,
  lap: 0,
  totalLaps: 0,
  loopAll: false,
};

/** Mirror of the active tab's engine, plus the command surface the UI calls.
 * While no engine is connected, commands fall back to optimistic local state so
 * panels stay usable (values are staged and pushed on connect). */
class SessionStore {
  connection = $state<ConnectionState>('detecting');
  media = $state<MediaInfo | null>(null);
  params = $state<EffectParams>(structuredClone(DEFAULT_PARAMS));
  volume = $state(1);
  t = $state(0);
  playing = $state(false);
  loop = $state<LoopState>({ ...IDLE_LOOP });
  seq = $state<SequenceState>({ ...IDLE_SEQ });
  /** Live count-in progress (loop restart, snippet lap, or manual play). */
  countIn = $state<CountInProgress | null>(null);
  lastError = $state<{ code: EngineErrorCode; detail?: string } | null>(null);
  /** Set while tab capture is active for the current tab. */
  capturing = $state(false);
  /** True while the engine is measuring the tempo (drives the DETECT spinner). */
  bpmDetecting = $state(false);
  /** Briefly true after a detection run that found no tempo (drives the hint). */
  bpmNoResult = $state(false);
  #bpmHintTimer: ReturnType<typeof setTimeout> | undefined;
  /** True while the engine is measuring the reference tuning (DETECT spinner). */
  tuningDetecting = $state(false);
  /** Briefly true after a tuning run that found nothing pitched (drives the hint). */
  tuningNoResult = $state(false);
  #tuningHintTimer: ReturnType<typeof setTimeout> | undefined;
  /** True between a source swap (SPA navigation) and the next media info:
   * the mirrored duration/markers/snippets belong to the OLD track, so seeks
   * issued from them would land on the new video at meaningless positions. */
  sourceChanging = $state(false);
  /** Engine's report that the DSP chain could not attach (page CSP blocks the
   * worklet, or the element is CORS/DRM tainted). Its own signal rather than a
   * read of `connection`: 'pitch-unavailable' only surfaces while the media
   * plays, and pausing doesn't bring the chain back. */
  #dspBlocked = $state(false);

  duration = $derived(this.media?.duration ?? 0);

  #sourceTimer: ReturnType<typeof setTimeout> | undefined;
  /** performance.now() until which `playing` reflects a scrub preview blip
   * rather than user-initiated playback. */
  #previewUntil = 0;

  /** True while a scrub preview blip may be what's playing. */
  get previewing(): boolean {
    return performance.now() < this.#previewUntil;
  }

  /** Wired by the connection layer (M2). Null = no engine attached. */
  #send: ((cmd: EngineCommand) => void) | null = null;

  /** Persistence hooks (set by track-sync). */
  onMediaEvent: ((media: MediaInfo | null) => void) | null = null;
  onUserParamsChange: (() => void) | null = null;
  /** The engine link dropped. Whatever reconnects starts on the default preset,
   * so the track's saved settings have to go back on even if it never changed. */
  onEngineDetached: (() => void) | null = null;
  /** Routes params/volume to the offscreen pipeline while capturing. */
  captureRelay: {
    params(patch: Partial<EffectParams>): void;
    volume(volume: number): void;
  } | null = null;

  attachTransport(send: (cmd: EngineCommand) => void) {
    this.#send = send;
  }

  detachTransport() {
    this.#send = null;
    this.playing = false;
    this.countIn = null;
    this.bpmDetecting = false;
    this.bpmNoResult = false;
    this.tuningDetecting = false;
    this.tuningNoResult = false;
    this.#dspBlocked = false;
    clearTimeout(this.#bpmHintTimer);
    clearTimeout(this.#tuningHintTimer);
    this.onEngineDetached?.();
  }

  get connected(): boolean {
    return this.#send !== null;
  }

  /** False while the DSP chain can't reach the audio, so pitch, transpose, the
   * vocal reducer and the EQ do nothing and their panels grey themselves out.
   * Speed is unaffected — it rides the element's playbackRate. Tab capture
   * brings its own pipeline in the offscreen document, which lifts the block. */
  get dspAvailable(): boolean {
    return this.capturing || !this.#dspBlocked;
  }

  /** Applies an engine event to the mirrored state. */
  apply(event: EngineEvent) {
    switch (event.type) {
      case 'snapshot':
        this.connection = event.state;
        this.#dspBlocked = !event.dspAvailable;
        this.media = event.media;
        this.params = event.params;
        this.volume = event.volume;
        this.loop = event.loop;
        this.seq = event.seq;
        this.t = event.t;
        this.playing = event.playing;
        this.countIn = null;
        this.#setSourceChanging(false);
        this.onMediaEvent?.(event.media);
        break;
      case 'source-changing':
        this.countIn = null;
        this.#setSourceChanging(true);
        break;
      case 'state':
        // With capture active, "pitch not available" becomes hybrid mode.
        this.connection =
          this.capturing && event.state === 'pitch-unavailable'
            ? 'connected-hybrid'
            : event.state;
        break;
      case 'dsp':
        this.#dspBlocked = !event.available;
        break;
      case 'media':
        this.media = event.media;
        // Zero duration = metadata still loading: keep seeks gated a moment
        // longer (mirrors track-sync's zero-duration grace period).
        if (event.media?.duration) this.#setSourceChanging(false);
        else if (this.sourceChanging) {
          clearTimeout(this.#sourceTimer);
          this.#sourceTimer = setTimeout(() => (this.sourceChanging = false), 3000);
        }
        this.onMediaEvent?.(event.media);
        break;
      case 'time':
        this.t = event.t;
        this.playing = event.playing;
        break;
      case 'params':
        this.params = event.params;
        break;
      case 'volume':
        this.volume = event.volume;
        break;
      case 'loop':
        this.loop = event.loop;
        break;
      case 'countdown':
        this.countIn = event.countdown;
        break;
      case 'seq':
        this.seq = event.seq;
        break;
      case 'bpm':
        this.bpmDetecting = event.detecting;
        if (event.detecting) {
          this.bpmNoResult = false;
          clearTimeout(this.#bpmHintTimer);
        } else if (event.bpm != null) {
          // Store the detected base tempo through the user-param path so it
          // persists per-track (like a manual bpm entry).
          this.patchParams({ baseBpm: event.bpm });
        } else {
          // Finished without a measurable tempo — flash a brief hint.
          this.bpmNoResult = true;
          clearTimeout(this.#bpmHintTimer);
          this.#bpmHintTimer = setTimeout(() => (this.bpmNoResult = false), 3000);
        }
        break;
      case 'tuning':
        this.tuningDetecting = event.detecting;
        if (event.detecting) {
          this.tuningNoResult = false;
          clearTimeout(this.#tuningHintTimer);
        } else if (event.hz != null) {
          // Store the measured A4 through the user-param path so it persists
          // per-track (like a manual entry).
          this.patchParams({ tuning: { ...this.params.tuning, trackHz: event.hz } });
        } else {
          // Finished without anything pitched to measure — flash a brief hint.
          this.tuningNoResult = true;
          clearTimeout(this.#tuningHintTimer);
          this.#tuningHintTimer = setTimeout(() => (this.tuningNoResult = false), 3000);
        }
        break;
      case 'error':
        this.lastError = { code: event.code, detail: event.detail };
        break;
    }
  }

  send(cmd: EngineCommand): boolean {
    if (!this.#send) return false;
    this.#send(cmd);
    return true;
  }

  #setSourceChanging(on: boolean) {
    clearTimeout(this.#sourceTimer);
    this.sourceChanging = on;
    if (on) {
      // Always arm a fallback: an href change may never be followed by a
      // media event (same source — e.g. a &t= timestamp link, miniplayer
      // browsing), and the gate must not latch seeks off forever.
      this.#sourceTimer = setTimeout(() => (this.sourceChanging = false), 3000);
    }
  }

  // ─── Transport ───────────────────────────────────────────────

  togglePlay() {
    this.#previewUntil = 0;
    if (!this.send({ type: 'transport', op: 'toggle' })) this.playing = !this.playing;
  }

  play() {
    this.#previewUntil = 0;
    if (!this.send({ type: 'transport', op: 'play' })) this.playing = true;
  }

  /** Seek to `t` and start playback with a count-in — the "play from here"
   * gesture. Routed through a dedicated command (not seek+play) so the count-in
   * runs even when playback is already live: a bare seek would skip it. */
  playFrom(t: number) {
    if (this.sourceChanging) return; // old-track coordinates mid source swap
    this.#previewUntil = 0;
    const clamped = Math.max(0, this.duration > 0 ? Math.min(this.duration, t) : t);
    this.t = clamped; // optimistic; the engine echoes the real position back
    if (!this.send({ type: 'playFrom', t: clamped })) this.playing = true;
  }

  jumpStart() {
    if (!this.send({ type: 'transport', op: 'jumpStart' })) this.t = 0;
  }

  skip(seconds: number) {
    if (!this.send({ type: 'transport', op: 'skip', value: seconds })) {
      this.t = Math.max(0, Math.min(this.duration, this.t + seconds));
    }
  }

  seek(t: number) {
    if (this.sourceChanging) return; // old-track coordinates mid source swap
    const clamped = Math.max(0, this.duration > 0 ? Math.min(this.duration, t) : t);
    // Optimistic: the engine's time event echoes back a round-trip later,
    // which reads as playhead lag when seeks come from a drag.
    this.t = clamped;
    this.send({ type: 'seek', t: clamped });
  }

  scrub(t: number, previewMs: number) {
    if (this.sourceChanging) return;
    this.#previewUntil = performance.now() + previewMs;
    this.t = t;
    this.send({ type: 'scrub', t, previewMs });
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.send({ type: 'volume', volume });
    if (this.capturing) this.captureRelay?.volume(volume);
  }

  // ─── Effect params ───────────────────────────────────────────

  patchParams(patch: Partial<EffectParams>) {
    if (patch.speed !== undefined) {
      patch.speed = clampSpeed(patch.speed);
    }
    Object.assign(this.params, patch);
    const snapshot = $state.snapshot(patch) as Partial<EffectParams>;
    this.send({ type: 'params', patch: snapshot });
    if (this.capturing) this.captureRelay?.params(snapshot);
    this.onUserParamsChange?.();
  }

  /** Ask the engine to measure the playing tempo and set `baseBpm`. The engine
   * replies with 'bpm' events (see apply); no-op with no engine attached. */
  detectBpm() {
    this.send({ type: 'detectBpm' });
  }

  /** Ask the engine to measure the song's reference A4 and set
   * `tuning.trackHz`. The engine replies with 'tuning' events (see apply). */
  detectTuning() {
    this.send({ type: 'detectTuning' });
  }

  /** True when every given param still holds its default value. */
  isDefault(keys: (keyof EffectParams)[]): boolean {
    return keys.every(
      (key) =>
        JSON.stringify(this.params[key]) === JSON.stringify(DEFAULT_PARAMS[key]),
    );
  }

  resetParam(keys: (keyof EffectParams)[]) {
    const patch: Partial<EffectParams> = {};
    for (const key of keys) {
      (patch as Record<string, unknown>)[key] = structuredClone(
        DEFAULT_PARAMS[key] as unknown,
      );
    }
    this.patchParams(patch);
  }

  togglePower() {
    this.patchParams({ power: !this.params.power });
  }

  // ─── Loops ───────────────────────────────────────────────────

  setLoopRange(startT: number, endT: number) {
    if (!this.send({ type: 'loop.set', startT, endT })) {
      this.loop = {
        mode: { kind: 'range', startT, endT },
        active: true,
        countIn: this.loop.countIn,
        lap: 1,
      };
    }
  }

  toggleLoop(on: boolean) {
    if (!this.send({ type: 'loop.toggle', on })) this.loop.active = on;
  }

  toggleRepeatSong(on: boolean) {
    if (!this.send({ type: 'loop.song', on })) {
      this.loop = on
        ? { mode: { kind: 'song' }, active: true, countIn: this.loop.countIn, lap: 1 }
        : { ...IDLE_LOOP, countIn: this.loop.countIn };
    }
  }

  toggleCountIn(on: boolean) {
    if (!this.send({ type: 'loop.countIn', on })) this.loop.countIn = on;
  }

  clearLoop() {
    if (!this.send({ type: 'loop.clear' })) {
      this.loop = { ...IDLE_LOOP, countIn: this.loop.countIn };
    }
  }

  // ─── Sequences ───────────────────────────────────────────────

  startSequence(snippets: SnippetRuntime[], fromSnippetId: string | undefined, loopAll: boolean) {
    if (this.sourceChanging) return; // snippet times are the old track's
    if (!this.send({ type: 'seq.start', snippets, fromSnippetId, loopAll })) {
      this.seq = {
        running: true,
        activeSnippetId: fromSnippetId ?? snippets[0]?.id ?? null,
        lap: 1,
        totalLaps: snippets[0]?.repeats ?? 1,
        loopAll,
      };
    }
  }

  updateSequence(snippets: SnippetRuntime[], loopAll: boolean) {
    this.send({ type: 'seq.update', snippets, loopAll });
  }

  stopSequence() {
    if (!this.send({ type: 'seq.stop' })) this.seq = { ...IDLE_SEQ };
  }
}

export const session = new SessionStore();
