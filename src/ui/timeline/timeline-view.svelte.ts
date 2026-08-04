import { session } from '@/core/state/session.svelte';

/** Horizontal zoom/pan for the Looper timeline, plus the auto-follow window
 * logic that rides on it. Deliberately NOT persisted: a two-second window is a
 * momentary reading position, not a preference (the auto-follow *toggle* it
 * works with does persist, in uiPrefs). Kept next to timeline-drag as a plain
 * rune singleton the Timeline reads directly. */

/** Narrowest window. Below ~1.5s the panel shows less than a bar at any useful
 * tempo, and the 30 Hz playhead starts reading as a strobe. */
const MIN_SPAN_S = 1.5;
/** Ceiling on the scaled inner element's width. A three-hour set at MIN_SPAN_S
 * would ask for millions of px; browsers lay that out but stop compositing it
 * cheaply. Only binds on very long tracks — the 1.5s floor binds first for
 * anything song-length. */
const MAX_INNER_PX = 120_000;
/** Wheel travel (px) that doubles or halves the zoom. Exponential in the delta
 * so a trackpad pinch composes: 2^(-a/D)·2^(-b/D) === 2^(-(a+b)/D), i.e. the
 * same total gesture gives the same zoom however the browser chunks it. */
export const ZOOM_DOUBLE_PX = 320;
/** Per keypress / toolbar click — coarser than a wheel notch. */
const ZOOM_STEP = 1.5;
/** Where the playhead lands after a follow page jump: a sliver of what just
 * played stays visible, and re-triggering needs most of a page. */
const FOLLOW_LEAD = 0.08;
/** Jump just *before* the playhead touches the right edge, so it never renders
 * half-clipped during the 33ms between engine ticks. */
const FOLLOW_EDGE = 0.02;
/** A |Δt| beyond what elapsed wall time explains is a seek or a loop wrap, not
 * playback — either way the user's attention moved, so follow resumes. */
const JUMP_EPS_S = 0.75;
/** How long the visible-span readout stays up after a view change. */
const HINT_MS = 900;

/** Full-track view, and the state any track starts in. */
const FIT = { key: '', startT: 0, spanT: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class TimelineView {
  /** Lane width in CSS px (bound from the Timeline). 0 until first layout. */
  laneW = $state(0);
  /** A manual pan/zoom parked the window away from the playhead. */
  followSuspended = $state(false);
  /** Briefly true after a view change — drives the transient span readout. */
  hintVisible = $state(false);
  /** Latches on the first zoom and never clears. The Looper's zoomed-only view
   * controls appear once and then stay in the row, greyed out at full-track
   * view, instead of the row rearranging itself every time. Panel-lifetime and
   * not per-track — having them disappear again on the next song would defeat
   * the point. */
  everZoomed = $state(false);

  /** The chosen window, tagged with the track it was chosen for. `spanT` 0 means
   * "fit"; both are stored unclamped so zooming out and back in returns you
   * where you were. */
  #chosen = $state(FIT);
  #hintTimer: ReturnType<typeof setTimeout> | undefined;
  // Playhead history for the seek/loop-wrap detector in onTick.
  #lastT = 0;
  #lastPerf = 0;
  #wasPlaying = false;

  /** Identity of the track the window belongs to. Null while a source swap is
   * in flight, when the mirrored duration still describes the previous track. */
  #trackKey = $derived(
    session.sourceChanging ? null : `${session.media?.pageUrl ?? ''}|${session.duration}`,
  );

  /** A window chosen for a different track is simply ignored, which resets the
   * view to fit on every track change — zoom is transient, and a two-second
   * window carried into another song frames nothing. A stale-check rather than
   * a reset effect, so a track change that happens while the Looper section is
   * collapsed (Timeline unmounted) still lands when it comes back. */
  #view = $derived(
    this.#trackKey !== null && this.#chosen.key === this.#trackKey ? this.#chosen : FIT,
  );

  /** Narrowest allowed span: the fixed floor, raised on very long tracks so the
   * scaled inner element stays under MAX_INNER_PX. */
  minSpan = $derived.by(() => {
    const d = session.duration;
    if (d <= 0) return 0;
    const byPx = this.laneW > 0 ? (d * this.laneW) / MAX_INNER_PX : 0;
    return Math.min(d, Math.max(MIN_SPAN_S, byPx));
  });

  span = $derived.by(() => {
    const d = session.duration;
    return d <= 0 ? 0 : clamp(this.#view.spanT || d, this.minSpan, d);
  });

  start = $derived.by(() => {
    const d = session.duration;
    return d <= 0 ? 0 : clamp(this.#view.startT, 0, Math.max(0, d - this.span));
  });

  end = $derived(this.start + this.span);
  zoom = $derived(this.span > 0 ? session.duration / this.span : 1);

  /** Full-track view: the timeline renders exactly as it did before zoom
   * existed (no transform, no clipping) and the indicators stay hidden. */
  atFit = $derived(session.duration <= 0 || this.span >= session.duration - 1e-6);
  /** Narrowest window this track allows — zoom in can go no further. */
  atMaxZoom = $derived(session.duration <= 0 || this.span <= this.minSpan + 1e-6);

  /** Left offset (px) for the scaled inner element. Inner width is
   * `zoom·laneW`, and time t sits at inner-x `(t/duration)·zoom·laneW`, so
   * putting `start` at screen x=0 needs `-(start/span)·laneW`. */
  panPx = $derived(this.span > 0 ? (this.start / this.span) * this.laneW : 0);

  /** The visible window as track %, for the minimap thumb. */
  startPct = $derived(session.duration > 0 ? (this.start / session.duration) * 100 : 0);
  spanPct = $derived(session.duration > 0 ? (this.span / session.duration) * 100 : 100);

  contains(t: number): boolean {
    return t >= this.start && t <= this.end;
  }

  /** Zoom keeping `anchorT` under the same pixel (factor > 1 zooms in). */
  zoomAround(anchorT: number, factor: number) {
    if (session.duration <= 0) return;
    const prevSpan = this.span;
    const next = clamp(prevSpan / factor, this.minSpan, session.duration);
    if (Math.abs(next - prevSpan) < 1e-9) return;
    // Hold the anchor's fractional position in the window constant.
    const frac = clamp((anchorT - this.start) / prevSpan, 0, 1);
    this.#choose(anchorT - frac * next, next);
  }

  /** One step in or out, for the toolbar buttons and the hotkeys. With no
   * pointer to anchor on, hold the playhead — or the window centre once it has
   * been panned out of view, so stepping never teleports you to it. */
  zoomStep(direction: 1 | -1) {
    const anchor = this.contains(session.t) ? session.t : this.start + this.span / 2;
    this.zoomAround(anchor, direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }

  zoomToFit() {
    this.#chosen = FIT;
    this.followSuspended = false;
    this.#flashHint();
  }

  /** Frame [a, b] with a little air on either side. */
  zoomToRange(a: number, b: number) {
    const d = session.duration;
    if (d <= 0) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const pad = Math.max(0.3, (hi - lo) * 0.08);
    const span = clamp(hi - lo + 2 * pad, this.minSpan, d);
    this.#choose((lo + hi) / 2 - span / 2, span);
  }

  panBy(dt: number) {
    if (this.atFit) return;
    this.#choose(this.start + dt, this.span);
  }

  panByPx(px: number) {
    if (this.laneW > 0) this.panBy((px / this.laneW) * this.span);
  }

  /** Pan by a drag on the minimap, where the full lane width spans the whole
   * track rather than the visible window — so the thumb tracks the pointer 1:1
   * instead of lagging it by the zoom factor. */
  panByTrackPx(px: number) {
    if (this.laneW > 0) this.panBy((px / this.laneW) * session.duration);
  }

  /** Put `t` in the middle of the window, keeping the current span. */
  centerOn(t: number) {
    if (this.atFit) return;
    this.#choose(t - this.span / 2, this.span);
  }

  /** Auto-follow, driven by the Timeline's engine-tick effect (~30 Hz). Pages
   * the window a screenful at a time rather than sliding it continuously — a
   * timeline creeping under the pins is distracting while playing along. */
  onTick(t: number, playing: boolean, follow: boolean, dragging: boolean) {
    const now = performance.now();
    const dt = Math.max(0, (now - this.#lastPerf) / 1000);
    const rate = session.params.speedEnabled ? session.params.speed : 1;
    const expected = this.#lastT + (playing ? dt * rate : 0);
    const jumped = Math.abs(t - expected) > Math.max(JUMP_EPS_S, 2 * dt * rate);
    const started = playing && !this.#wasPlaying;
    this.#lastT = t;
    this.#lastPerf = now;
    this.#wasPlaying = playing;

    if (this.atFit) return; // the playhead is always in view
    // Resume: playback restarting, a seek or loop wrap moving the user's
    // attention, or the playhead simply wandering back into the window.
    if (started || jumped || this.contains(t)) this.followSuspended = false;
    if (!follow || this.followSuspended || dragging) return;
    if (t < this.start || t > this.end - FOLLOW_EDGE * this.span) {
      this.#chosen = { ...this.#view, startT: t - FOLLOW_LEAD * this.span };
    }
  }

  /** Commit a manually chosen window. Only a change that leaves the playhead
   * behind counts as "the user went to look elsewhere" — one that keeps it
   * visible needn't suspend, since follow will page as usual once it exits. */
  #choose(startT: number, spanT: number) {
    const key = this.#trackKey;
    if (key === null) return; // source swap in flight; these coordinates are stale
    this.#chosen = { key, startT, spanT };
    // Every route into a zoomed view lands here — wheel, hotkey, button, marker
    // range — so this is the one place the latch has to be set.
    if (!this.atFit) this.everZoomed = true;
    this.followSuspended = !this.contains(session.t);
    this.#flashHint();
  }

  #flashHint() {
    clearTimeout(this.#hintTimer);
    if (this.atFit) {
      this.hintVisible = false;
      return;
    }
    this.hintVisible = true;
    this.#hintTimer = setTimeout(() => (this.hintVisible = false), HINT_MS);
  }
}

export const timelineView = new TimelineView();
