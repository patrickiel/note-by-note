import type { Snippet, SnippetRuntime } from '../../../core/model/types';
import { session } from '../../../core/state/session.svelte';

let nextId = 1;
function newId(): string {
  return `c${Date.now().toString(36)}-${nextId++}`;
}

/** Snippets (ordered) for the current track + sequence controls. */
class SnippetsStore {
  list = $state<Snippet[]>([]);
  sequenceLoop = $state(false);
  /** Count in when pressing play and before each snippet repeat lap — but not on
   * snippet transitions or the whole-section loop (one toggle for the whole list). */
  sequenceCountIn = $state(false);

  onPersist: (() => void) | null = null;

  #persist() {
    this.onPersist?.();
  }

  load(snippets: Snippet[], sequenceLoop: boolean, sequenceCountIn = false) {
    // `repeats: Infinity` serializes to `null` through JSON (storage + sync);
    // restore it here so an infinite snippet survives a round-trip.
    this.list = snippets.map((s) => (s.repeats == null ? { ...s, repeats: Infinity } : s));
    this.sequenceLoop = sequenceLoop;
    this.sequenceCountIn = sequenceCountIn;
  }

  /** `✂` toolbar action: save the selected range as a snippet. */
  addFromRange(startT: number, endT: number): Snippet {
    const snippet: Snippet = {
      id: newId(),
      name: 'Snippet',
      startT,
      endT,
      enabled: true,
      repeats: 1,
      overrides: {},
    };
    this.list.push(snippet);
    this.#persist();
    return snippet;
  }

  update(id: string, patch: Partial<Snippet>) {
    const snippet = this.list.find((c) => c.id === id);
    if (!snippet) return;
    Object.assign(snippet, patch);
    this.#persist();
    this.#syncRunning();
  }

  duplicate(id: string) {
    const index = this.list.findIndex((c) => c.id === id);
    if (index < 0) return;
    const source = $state.snapshot(this.list[index]) as Snippet;
    this.list.splice(index + 1, 0, { ...source, id: newId() });
    this.#persist();
  }

  remove(id: string) {
    this.list = this.list.filter((c) => c.id !== id);
    this.#persist();
    this.#syncRunning();
  }

  reorder(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    const [moved] = this.list.splice(fromIndex, 1);
    this.list.splice(toIndex, 0, moved);
    this.#persist();
    this.#syncRunning();
  }

  toggleSequenceLoop() {
    this.sequenceLoop = !this.sequenceLoop;
    this.#persist();
    this.#syncRunning();
  }

  toggleSequenceCountIn() {
    this.sequenceCountIn = !this.sequenceCountIn;
    this.#persist();
    this.#syncRunning();
  }

  /** Enabled snippets in play order, in the shape the engine consumes. */
  runtime(): SnippetRuntime[] {
    return this.list
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        name: c.name,
        startT: c.startT,
        endT: c.endT,
        repeats: c.repeats,
        countIn: this.sequenceCountIn,
        overrides: $state.snapshot(c.overrides),
      }));
  }

  /** ▶ on a snippet card: start playback there; sequence continues onwards. */
  play(fromSnippetId: string) {
    session.startSequence(this.runtime(), fromSnippetId, this.sequenceLoop);
  }

  stop() {
    session.stopSequence();
  }

  /** Push edits to a running sequence. */
  #syncRunning() {
    if (session.seq.running) session.updateSequence(this.runtime(), this.sequenceLoop);
  }
}

export const snippets = new SnippetsStore();
