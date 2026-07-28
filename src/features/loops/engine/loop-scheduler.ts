import type { LoopMode, LoopState } from '../../../core/model/types';
import type { CountIn } from '../../count-in/engine/count-in';
import type { MediaEngine } from '../../../core/engine/media-engine';

export interface LoopSchedulerEvents {
  onLoop(state: LoopState): void;
}

/** Enforces loop boundaries (marker range, whole song) with count-in.
 * Driven by MediaEngine ticks (rAF + interval + audio clock, see content.ts). */
export class LoopScheduler {
  #engine: MediaEngine;
  #countIn: CountIn;
  #events: LoopSchedulerEvents;
  #state: LoopState = { mode: null, active: false, countIn: false, lap: 0 };
  #lastRestart = 0;
  /** Set after a restart until a tick lands back inside the loop bounds —
   * only then can a boundary re-hit mean the restart didn't take. */
  #awaitingRestart = false;

  constructor(engine: MediaEngine, countIn: CountIn, events: LoopSchedulerEvents) {
    this.#engine = engine;
    this.#countIn = countIn;
    this.#events = events;
  }

  get state(): LoopState {
    return this.#state;
  }

  #emit() {
    this.#events.onLoop({ ...this.#state });
  }

  setRange(startT: number, endT: number) {
    this.#state = {
      mode: { kind: 'range', startT, endT },
      active: true,
      countIn: this.#state.countIn,
      lap: 1,
    };
    this.#emit();
  }

  toggle(on: boolean) {
    this.#state.active = on && this.#state.mode !== null;
    if (this.#state.active && this.#state.lap === 0) this.#state.lap = 1;
    if (!on) this.#countIn.cancel();
    this.#emit();
  }

  setSong(on: boolean) {
    this.#state = on
      ? { mode: { kind: 'song' }, active: true, countIn: this.#state.countIn, lap: 1 }
      : { mode: null, active: false, countIn: this.#state.countIn, lap: 0 };
    if (!on) this.#countIn.cancel();
    this.#emit();
  }

  setCountIn(on: boolean) {
    this.#state.countIn = on;
    this.#emit();
  }

  clear() {
    this.#countIn.cancel();
    this.#state = { mode: null, active: false, countIn: this.#state.countIn, lap: 0 };
    this.#emit();
  }

  #bounds(mode: LoopMode): { startT: number; endT: number } | null {
    switch (mode.kind) {
      case 'range':
        return { startT: mode.startT, endT: mode.endT };
      case 'song':
        return this.#engine.duration > 0
          ? { startT: 0, endT: this.#engine.duration }
          : null;
    }
  }

  /** Called from the engine tick. Returns true when it consumed the boundary
   * (so the sequence scheduler and others skip this tick). */
  tick(t: number): boolean {
    if (!this.#state.active || !this.#state.mode || this.#countIn.active) {
      return this.#countIn.active;
    }
    const bounds = this.#bounds(this.#state.mode);
    if (!bounds || bounds.endT - bounds.startT < 0.15) return false;
    // Song mode restarts on 'ended' as well as on reaching the end.
    if (t >= bounds.endT - 0.03 || this.#engine.el.ended) {
      // Cooldown ONLY while a restart hasn't taken effect (rejected play(),
      // dropped seek) — ticks would re-fire the boundary every frame and
      // seek-spam the element. A legitimate short lap restarts instantly.
      const now = performance.now();
      if (this.#awaitingRestart && now - this.#lastRestart < 300) return true;
      this.#awaitingRestart = true;
      this.#lastRestart = now;
      this.#state.lap += 1;
      this.#restart(bounds.startT);
      this.#emit();
      return true;
    }
    this.#awaitingRestart = false;
    return false;
  }

  #restart(startT: number) {
    if (this.#state.countIn) {
      this.#countIn.run(this.#engine, startT, () => this.#engine.play());
    } else {
      this.#engine.seek(startT);
      if (!this.#engine.playing) this.#engine.play();
    }
  }

  dispose() {
    // The Controller owns the shared count-in lifecycle; nothing to tear down here.
  }
}
