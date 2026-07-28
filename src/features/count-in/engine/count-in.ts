import { COUNT_IN_BEATS_RANGE, COUNT_IN_BPM_RANGE } from '../../../core/model/defaults';
import type { CountInProgress } from '../../../core/model/types';
import type { MediaEngine } from '../../../core/engine/media-engine';
import type { Metronome } from './metronome';

export interface CountInConfig {
  beats: number;
  bpm: number;
  beep: boolean;
}

function clamp(n: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The single count-in runner, owned by the Controller and shared by the loop
 * scheduler, the sequence scheduler, and the manual-play path (they are mutually
 * exclusive, so one runner is enough). It pauses the element, optionally seeks,
 * counts `beats` clicks at `bpm` while broadcasting progress, then resumes
 * playback on the downbeat after the last click. */
export class CountIn {
  #metronome: Metronome;
  #emit: (progress: CountInProgress | null) => void;
  /** True only in direct/local mode — beeps in capture mode would be re-captured. */
  #canBeep: () => boolean;
  #config: CountInConfig = { beats: 4, bpm: 100, beep: true };
  #timer: ReturnType<typeof setInterval> | undefined;
  #active = false;

  constructor(
    metronome: Metronome,
    emit: (progress: CountInProgress | null) => void,
    canBeep: () => boolean,
  ) {
    this.#metronome = metronome;
    this.#emit = emit;
    this.#canBeep = canBeep;
  }

  get active(): boolean {
    return this.#active;
  }

  setConfig(cfg: CountInConfig) {
    this.#config = {
      beats: clamp(Math.round(cfg.beats) || 4, COUNT_IN_BEATS_RANGE),
      bpm: clamp(Math.round(cfg.bpm) || 100, COUNT_IN_BPM_RANGE),
      beep: cfg.beep,
    };
  }

  /** The song's tempo from the Speed panel (baseBpm × effective speed), or null
   * when no base tempo is set. When present it drives the count-in in preference
   * to the configured fixed BPM, so the count matches the tempo playback resumes
   * at. Mirrors SpeedPanel's effective-bpm display (power is not factored in). */
  #songBpm(engine: MediaEngine): number | null {
    const { baseBpm, speed, speedEnabled } = engine.params;
    if (baseBpm == null) return null;
    const bpm = baseBpm * (speedEnabled ? speed : 1);
    return bpm > 0 ? clamp(bpm, COUNT_IN_BPM_RANGE) : null;
  }

  /** Pause, optionally seek to `seekTo`, count in, then call `onDone` (play). */
  run(engine: MediaEngine, seekTo: number | null, onDone: () => void) {
    this.cancel();
    const { beats, beep } = this.#config;
    const bpm = this.#songBpm(engine) ?? this.#config.bpm;
    const intervalMs = 60000 / bpm;
    this.#active = true;
    engine.pause();
    if (seekTo != null) engine.seek(seekTo);
    if (beep && this.#canBeep()) this.#metronome.scheduleClicks(beats, bpm);
    let beat = 1;
    // Emit synchronously (before the queued 'pause' event's state broadcast) so
    // the panel sees the count-in and suppresses the "Start playback" prompt.
    this.#emitBeat(beat, beats, intervalMs);
    this.#timer = setInterval(() => {
      beat += 1;
      if (beat > beats) this.#finish(onDone);
      else this.#emitBeat(beat, beats, intervalMs);
    }, intervalMs);
  }

  /** Abort an in-progress count-in without resuming playback (stays paused). */
  cancel() {
    if (!this.#active) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#active = false;
    this.#metronome.stop();
    this.#emit(null);
  }

  dispose() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#active = false;
  }

  #finish(onDone: () => void) {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#active = false;
    this.#emit(null);
    onDone();
  }

  #emitBeat(beat: number, beats: number, intervalMs: number) {
    this.#emit({
      remainingMs: Math.round((beats - beat + 1) * intervalMs),
      beat,
      beats,
    });
  }
}
