import type { SnippetRuntime, EffectParams, SequenceState } from '../../../core/model/types';
import type { CountIn } from '../../count-in/engine/count-in';
import type { MediaEngine } from '../../../core/engine/media-engine';

export interface SequenceSchedulerEvents {
  onSeq(state: SequenceState): void;
}

/** `repeats: Infinity` (loop forever) serializes to `null` over the JSON-based
 * runtime port, so normalize either form back to Infinity on ingest. */
const laps = (repeats: number | null): number => (Number.isFinite(repeats) ? repeats! : Infinity);

const IDLE: SequenceState = {
  running: false,
  activeSnippetId: null,
  lap: 0,
  totalLaps: 0,
  loopAll: false,
};

/** Plays chained snippets: honors per-snippet repeats, count-in, and effect
 * overrides; optionally loops the whole sequence. Overrides are applied on
 * snippet start and rolled back to the pre-sequence baseline at the end. */
export class SequenceScheduler {
  #engine: MediaEngine;
  #countIn: CountIn;
  #events: SequenceSchedulerEvents;
  #snippets: SnippetRuntime[] = [];
  #index = 0;
  #lap = 1;
  #loopAll = false;
  #running = false;
  #baseline: Partial<EffectParams> | null = null;
  #lastAdvance = 0;
  /** True until the first snippet is entered. Pressing play counts in when the
   * section count-in flag is on; snippet-to-snippet transitions and the
   * whole-section loop-around never count in. */
  #firstEntry = true;
  /** Set after an advance until a tick lands back inside the active snippet —
   * only then can a boundary re-hit mean the advance didn't take. */
  #awaitingAdvance = false;

  constructor(engine: MediaEngine, countIn: CountIn, events: SequenceSchedulerEvents) {
    this.#engine = engine;
    this.#countIn = countIn;
    this.#events = events;
  }

  get running(): boolean {
    return this.#running;
  }

  state(): SequenceState {
    const snippet = this.#snippets[this.#index];
    return this.#running
      ? {
          running: true,
          activeSnippetId: snippet?.id ?? null,
          lap: this.#lap,
          totalLaps: snippet ? laps(snippet.repeats) : 1,
          loopAll: this.#loopAll,
        }
      : { ...IDLE };
  }

  #emit() {
    this.#events.onSeq(this.state());
  }

  start(snippets: SnippetRuntime[], fromSnippetId: string | undefined, loopAll: boolean) {
    this.stop(false);
    // A near-zero-length snippet would re-fire the boundary on every tick — a
    // 60Hz seek+play storm the page player can't survive (same 0.15s floor
    // as the loop scheduler).
    snippets = snippets.filter((c) => c.endT - c.startT >= 0.15);
    if (!snippets.length) return;
    this.#snippets = snippets;
    this.#loopAll = loopAll;
    this.#index = Math.max(
      0,
      fromSnippetId ? snippets.findIndex((c) => c.id === fromSnippetId) : 0,
    );
    this.#lap = 1;
    this.#running = true;
    this.#firstEntry = true;
    // Remember pre-sequence values of every key any snippet overrides.
    this.#baseline = {};
    for (const snippet of snippets) {
      for (const key of Object.keys(snippet.overrides) as (keyof EffectParams)[]) {
        if (!(key in this.#baseline)) {
          (this.#baseline as Record<string, unknown>)[key] = structuredClone(
            this.#engine.params[key] as unknown,
          );
        }
      }
    }
    this.#enterSnippet();
  }

  /** Live edits from the UI while running (reorder, toggles, overrides). */
  update(snippets: SnippetRuntime[], loopAll: boolean) {
    if (!this.#running) return;
    const activeId = this.#snippets[this.#index]?.id;
    this.#loopAll = loopAll;
    snippets = snippets.filter((c) => c.endT - c.startT >= 0.15);
    this.#snippets = snippets;
    if (!snippets.length) {
      this.stop();
      return;
    }
    const newIndex = snippets.findIndex((c) => c.id === activeId);
    this.#index = newIndex >= 0 ? newIndex : Math.min(this.#index, snippets.length - 1);
    this.#emit();
  }

  stop(emit = true) {
    if (this.#running && this.#baseline && Object.keys(this.#baseline).length) {
      this.#engine.patchParams(this.#baseline);
    }
    this.#countIn.cancel();
    this.#running = false;
    this.#snippets = [];
    this.#baseline = null;
    if (emit) this.#emit();
  }

  tick(t: number): boolean {
    if (!this.#running) return false;
    if (this.#countIn.active) return true;
    const snippet = this.#snippets[this.#index];
    if (!snippet) return false;
    if (t >= snippet.endT - 0.03 || this.#engine.el.ended) {
      // Cooldown mirrors the loop scheduler: only an advance that didn't
      // take effect is held back — short snippets advance instantly.
      const now = performance.now();
      if (this.#awaitingAdvance && now - this.#lastAdvance < 300) return true;
      this.#awaitingAdvance = true;
      this.#lastAdvance = now;
      this.#advance();
      return true;
    }
    this.#awaitingAdvance = false;
    return false;
  }

  #advance() {
    const snippet = this.#snippets[this.#index];
    if (this.#lap < laps(snippet.repeats)) {
      this.#lap += 1;
      this.#emit();
      this.#beginLap(snippet, snippet.countIn);
      return;
    }
    if (this.#index + 1 < this.#snippets.length) {
      this.#index += 1;
      this.#lap = 1;
      this.#enterSnippet();
      return;
    }
    if (this.#loopAll) {
      this.#index = 0;
      this.#lap = 1;
      this.#enterSnippet();
      return;
    }
    this.stop();
    this.#engine.pause();
  }

  #enterSnippet() {
    const snippet = this.#snippets[this.#index];
    if (!snippet) {
      this.stop();
      return;
    }
    // Baseline + this snippet's overrides = the snippet's effective settings.
    if (this.#baseline && Object.keys(this.#baseline).length) {
      this.#engine.patchParams({ ...this.#baseline, ...snippet.overrides });
    } else if (Object.keys(snippet.overrides).length) {
      this.#engine.patchParams({ ...snippet.overrides });
    }
    this.#emit();
    // Count in only when pressing play (first entry) and the section count-in
    // flag is on. Snippet-to-snippet transitions and the whole-section
    // loop-around (both re-enter here with #firstEntry already false) never
    // count in; repeat laps use the same flag in #advance.
    const withCountIn = this.#firstEntry && snippet.countIn;
    this.#firstEntry = false;
    this.#beginLap(snippet, withCountIn);
  }

  #beginLap(snippet: SnippetRuntime, withCountIn: boolean) {
    if (withCountIn) {
      this.#countIn.run(this.#engine, snippet.startT, () => this.#engine.play());
    } else {
      this.#engine.seek(snippet.startT);
      if (!this.#engine.playing) this.#engine.play();
    }
  }

  dispose() {
    // The Controller owns the shared count-in lifecycle; nothing to tear down here.
  }
}
