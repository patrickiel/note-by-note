import type { Marker } from '../../../core/model/types';
import { session } from '../../../core/state/session.svelte';

let nextId = 1;
function newId(): string {
  return `m${Date.now().toString(36)}-${nextId++}`;
}

/** Sentinel ids for the virtual Start/End track boundaries. They aren't real
 * markers (never in `list`, never persisted) but can still be loop-range
 * endpoints — the range/pick flow resolves their times via #timeOf. */
const START_ID = '__start__';
const END_ID = '__end__';

/** Tolerance (seconds) for matching a restored loop endpoint back to a
 * marker/boundary. Endpoint times round-trip exactly for markers and the Start
 * boundary, so this is really only slack for the End boundary when a reload
 * reports a slightly different duration — kept well under typical marker
 * spacing so it can't latch onto the wrong tile. */
const RANGE_MATCH_EPS = 0.1;

/** Markers for the current track plus the loop-range / edit-mode UI flow. */
class MarkersStore {
  list = $state<Marker[]>([]);
  editMode = $state(false);
  /** Endpoints of the selected loop range (real markers or virtual Start/End). */
  rangeStartId = $state<string | null>(null);
  rangeEndId = $state<string | null>(null);
  /** Marker whose chip/row is currently hovered — mirrored on its timeline pin. */
  hoveredId = $state<string | null>(null);

  sorted = $derived([...this.list].sort((a, b) => a.t - b.t));

  /** Called by the persistence layer when the track changes. */
  onPersist: ((markers: Marker[]) => void) | null = null;

  #persist() {
    this.onPersist?.($state.snapshot(this.list));
  }

  load(markers: Marker[]) {
    this.list = markers;
    this.hoveredId = null;
    this.#restoreRangeFromLoop();
  }

  /** The loop itself is restored from the engine snapshot, but the panel-only
   * range *selection* (which marker/boundary each endpoint is) starts empty on
   * a fresh panel — so the region would render yet no tile/pin would highlight
   * and dragging an endpoint marker wouldn't move it. Re-derive the endpoint
   * ids by matching the restored range's times back to the current
   * markers/boundaries. Runs after every track load; leaves both null when the
   * loop isn't a range or an endpoint doesn't line up with a tile. */
  #restoreRangeFromLoop() {
    this.rangeStartId = null;
    this.rangeEndId = null;
    const mode = session.loop.mode;
    if (mode?.kind !== 'range') return;
    const startId = this.#targetIdAt(mode.startT);
    const endId = this.#targetIdAt(mode.endT);
    // Only adopt the selection when both ends map to a tile — a half-known
    // range would arm #syncRange on an endpoint the user can't see selected.
    if (startId === null || endId === null) return;
    this.rangeStartId = startId;
    this.rangeEndId = endId;
  }

  /** The marker/boundary id whose time is closest to `t`, or null when the
   * nearest is still further than RANGE_MATCH_EPS. Ties keep the earlier
   * pick target (Start, then markers, then End). */
  #targetIdAt(t: number): string | null {
    let bestId: string | null = null;
    let bestDelta = Infinity;
    for (const tg of this.#pickTargets()) {
      const delta = Math.abs(tg.t - t);
      if (delta < bestDelta) {
        bestId = tg.id;
        bestDelta = delta;
      }
    }
    return bestDelta <= RANGE_MATCH_EPS ? bestId : null;
  }

  indexOf(id: string): number {
    return this.sorted.findIndex((m) => m.id === id);
  }

  add(t: number = session.t): Marker {
    const marker: Marker = { id: newId(), t, label: '' };
    this.list.push(marker);
    this.#persist();
    return marker;
  }

  move(id: string, t: number) {
    const marker = this.list.find((m) => m.id === id);
    if (!marker) return;
    marker.t = Math.max(0, session.duration > 0 ? Math.min(session.duration, t) : t);
    this.#syncRange(id);
    this.#persist();
  }

  /** Keep the loop range in step when one of its endpoint markers moves.
   * Only while a range loop is set — never clobbers a song loop. */
  #syncRange(id: string) {
    if (id !== this.rangeStartId && id !== this.rangeEndId) return;
    if (session.loop.mode?.kind !== 'range') return;
    const wasActive = session.loop.active;
    this.applyRange();
    if (!wasActive) session.toggleLoop(false);
  }

  rename(id: string, label: string) {
    const marker = this.list.find((m) => m.id === id);
    if (!marker) return;
    marker.label = label;
    this.#persist();
  }

  remove(id: string) {
    this.list = this.list.filter((m) => m.id !== id);
    if (this.rangeStartId === id || this.rangeEndId === id) this.clearRange();
    this.#persist();
  }

  /** Set a marker to the current playback position (edit-mode bookmark button). */
  setToPlayhead(id: string) {
    this.move(id, session.t);
  }

  jumpTo(id: string) {
    const marker = this.list.find((m) => m.id === id);
    if (marker) session.seek(marker.t);
  }

  /** Seek to the marker and start playback (the "play from marker" gesture). */
  playFrom(id: string) {
    const marker = this.list.find((m) => m.id === id);
    if (marker) session.playFrom(marker.t);
  }

  prevMarker(): Marker | null {
    const before = this.sorted.filter((m) => m.t < session.t - 0.3);
    return before[before.length - 1] ?? null;
  }

  nextMarker(): Marker | null {
    return this.sorted.find((m) => m.t > session.t + 0.3) ?? null;
  }

  // ─── Range selection ──────────────────────────────────

  /** Time of a pick target — a real marker or a virtual Start/End boundary.
   * Null when the id resolves to neither (e.g. an unset endpoint). */
  #timeOf(id: string | null): number | null {
    if (id === START_ID) return 0;
    if (id === END_ID) return session.duration;
    return this.list.find((m) => m.id === id)?.t ?? null;
  }

  /** Sentinel id for a virtual boundary, for the pick / inRange flow. */
  boundaryId(which: 'start' | 'end'): string {
    return which === 'start' ? START_ID : END_ID;
  }

  get range(): { startT: number; endT: number } | null {
    const a = this.#timeOf(this.rangeStartId);
    const b = this.#timeOf(this.rangeEndId);
    if (a === null || b === null) return null;
    return a <= b ? { startT: a, endT: b } : { startT: b, endT: a };
  }

  /** True when the marker or virtual boundary lies inside the selected loop
   * range or is one of its endpoints (which covers a picked start while the
   * end is still unchosen). */
  inRange(id: string): boolean {
    if (id === this.rangeStartId || id === this.rangeEndId) return true;
    const range = this.range;
    if (!range) return false;
    const t = this.#timeOf(id);
    return t !== null && t >= range.startT && t <= range.endT;
  }

  /** True for a marker/boundary inside the selected loop range, END-EXCLUSIVE:
   * a range runs *up to* its end marker, so that end tile is left unhighlighted
   * (highlighting it reads as if it were "also selected"). For a single-section
   * range this is just the start tile; a multi-marker range also covers the
   * markers in between. */
  inRangeExclEnd(id: string): boolean {
    if (id === this.rangeEndId) return false;
    const range = this.range;
    if (!range || range.endT <= range.startT) return false;
    const t = this.#timeOf(id);
    return t !== null && t >= range.startT && t < range.endT;
  }

  /** The ordered loop-range endpoints by time: the virtual Start, every marker,
   * then the virtual End. A click loops the section from its target to the next
   * entry here. */
  #pickTargets(): { id: string; t: number }[] {
    return [
      { id: START_ID, t: 0 },
      ...this.sorted.map((m) => ({ id: m.id, t: m.t })),
      { id: END_ID, t: session.duration },
    ];
  }

  /** Select and activate a loop range from the given marker/boundary to the
   * next one by time. Skips same-instant neighbours so a range is never
   * zero-length; the End boundary has no successor, so it selects nothing
   * (returns false). */
  selectRangeFrom(id: string): boolean {
    // No track metadata yet: End resolves to 0 and would bake in a stale loop.
    if (session.duration <= 0) return false;
    // Mid source swap the marker times are the old track's — don't arm a loop
    // on stale coordinates (mirrors the seek/playFrom gates).
    if (session.sourceChanging) return false;
    const targets = this.#pickTargets();
    const from = targets.find((tg) => tg.id === id);
    if (!from) return false;
    // Ascending by time, so the first entry past `from` is its next section end.
    const next = targets.find((tg) => tg.t > from.t);
    if (!next) return false;
    this.rangeStartId = id;
    this.rangeEndId = next.id;
    this.applyRange();
    return true;
  }

  /** The two endpoint targets a drag between two tiles resolves to: the earlier
   * tile, and the section-end *after* the later tile — each tile is a section
   * (marker → next), so dragging onto a tile includes its whole section. When
   * the later tile is already the last target (End) nothing follows it, so it
   * caps the range itself. Null for a non-span (missing id or same instant). */
  #spanTargets(
    idA: string,
    idB: string,
  ): { start: { id: string; t: number }; end: { id: string; t: number } } | null {
    const targets = this.#pickTargets();
    const a = targets.find((tg) => tg.id === idA);
    const b = targets.find((tg) => tg.id === idB);
    if (!a || !b || a.t === b.t) return null;
    const [earlier, later] = a.t <= b.t ? [a, b] : [b, a];
    const end = targets.find((tg) => tg.t > later.t) ?? later;
    return { start: earlier, end };
  }

  /** The {startT, endT} a drag between two tiles would loop — for the live
   * preview highlight before it's committed. */
  spanRange(idA: string, idB: string): { startT: number; endT: number } | null {
    const span = this.#spanTargets(idA, idB);
    return span ? { startT: span.start.t, endT: span.end.t } : null;
  }

  /** Drag-select: loop every section between two tiles, in either drag
   * direction — from the earlier tile up to the marker after the later one. */
  selectRangeBetween(idA: string, idB: string): boolean {
    if (session.duration <= 0 || session.sourceChanging) return false;
    const span = this.#spanTargets(idA, idB);
    if (!span) return false;
    this.rangeStartId = span.start.id;
    this.rangeEndId = span.end.id;
    this.applyRange();
    return true;
  }

  /** Practice the section at this marker/boundary: loop from it to the next one
   * and play from it. No-op for the End boundary (nothing follows it). */
  playSectionFrom(id: string) {
    if (!this.selectRangeFrom(id)) return;
    const t = this.#timeOf(id);
    if (t !== null) session.playFrom(t);
  }

  /** Keyboard "loop section": arm a loop for the section the playhead sits in —
   * from the nearest marker/Start at or before it to the next one. */
  selectCurrentSection() {
    const targets = this.#pickTargets();
    let from = targets[0];
    for (const tg of targets) {
      if (tg.t <= session.t + 0.001) from = tg;
      else break;
    }
    this.selectRangeFrom(from.id);
  }

  applyRange() {
    const range = this.range;
    if (range) session.setLoopRange(range.startT, range.endT);
  }

  clearRange() {
    this.rangeStartId = null;
    this.rangeEndId = null;
    if (session.loop.mode?.kind === 'range') session.clearLoop();
  }
}

export const markers = new MarkersStore();
