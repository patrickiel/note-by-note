<script lang="ts">
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { formatClock } from '@/core/model/format';
  import { markers } from '@/features/markers/panel/markers.svelte';
  import { session } from '@/core/state/session.svelte';
  import { settings, uiPrefs } from '@/features/settings/panel/settings.svelte';
  import { timelineDrag } from './timeline-drag.svelte';
  import { timelineView, ZOOM_DOUBLE_PX } from './timeline-view.svelte';
  import { IS_MAC } from '@/ui/shared/hotkey';
  import MarkerPin from '../../features/markers/panel/MarkerPin.svelte';

  /** Pointer travel is scaled by this while Shift is held (10× finer). */
  const FINE_FACTOR = 0.1;

  let trackEl: HTMLDivElement | undefined;
  let scrubbing = $state(false);
  // Effective clientX fed to timeAt while scrubbing. Tracks the pointer 1:1
  // normally; advances by FINE_FACTOR·Δ while Shift is held, so toggling Shift
  // mid-scrub re-gears the playhead without it jumping (mirrors MarkerPin).
  let scrubX = 0;
  let scrubLastX = 0;
  // Cursor-time while dragging: seeks are throttled and round-trip through the
  // page player, so rendering the playhead from session.t would trail the
  // pointer. Held briefly past release so a stale in-flight time event can't
  // snap the playhead back before the final seek echoes.
  let dragT = $state<number | null>(null);
  let dragClearTimer: ReturnType<typeof setTimeout> | undefined;

  const playPct = $derived.by(() => {
    if (session.duration <= 0) return 0;
    const t = dragT ?? session.t;
    return Math.min(100, Math.max(0, (t / session.duration) * 100));
  });

  /** Loop range highlight (range mode), as track %. */
  const loopRegion = $derived.by(() => {
    const mode = session.loop.mode;
    if (!mode || session.duration <= 0) return null;
    let startT: number;
    let endT: number;
    if (mode.kind === 'range') {
      startT = mode.startT;
      endT = mode.endT;
    } else {
      return null;
    }
    const left = Math.min(100, Math.max(0, (startT / session.duration) * 100));
    const right = Math.min(100, Math.max(0, (endT / session.duration) * 100));
    return { left, width: Math.max(0, right - left) };
  });

  /** Pointer clientX → track time in seconds (also used by MarkerPin drags). */
  function timeAt(clientX: number): number {
    if (!trackEl) return 0;
    const rect = trackEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * session.duration;
  }

  // Every seek aborts the page player's in-flight segment fetches (fatal to
  // YouTube's SABR streaming at pointer-event rate) — coalesce drag/key-repeat
  // seeks to one per interval, always sending the latest position.
  const SEEK_THROTTLE_MS = 150;
  let lastApply = 0;
  let pendingT: number | null = null;
  let applyTimer: ReturnType<typeof setTimeout> | undefined;
  // Captured at pointer-down: the scrub preview itself flips session.playing
  // to true mid-drag, so routing on the live value would switch a paused drag
  // to live seeks (cancelling the preview and leaving playback running).
  let dragLive = false;

  /** Playing → live seek; paused → short scrub preview. Throttled. */
  function applyPointer(t: number) {
    pendingT = t;
    const wait = lastApply + SEEK_THROTTLE_MS - performance.now();
    if (wait <= 0) flushPointer();
    else applyTimer ??= setTimeout(flushPointer, wait);
  }

  function flushPointer() {
    clearTimeout(applyTimer);
    applyTimer = undefined;
    if (pendingT === null) return;
    lastApply = performance.now();
    const t = pendingT;
    pendingT = null;
    if (dragLive) session.seek(t);
    else session.scrub(t, settings.current.scrubPreviewMs);
  }

  function cancelPending() {
    clearTimeout(applyTimer);
    applyTimer = undefined;
    pendingT = null;
  }

  /** Advance the effective scrub position by the latest pointer delta (scaled
   * while Shift is held) and return the resulting track time. */
  function scrubTimeAt(event: PointerEvent): number {
    const dx = event.clientX - scrubLastX;
    scrubLastX = event.clientX;
    scrubX += event.shiftKey ? dx * FINE_FACTOR : dx;
    return timeAt(scrubX);
  }

  function onTrackDown(event: PointerEvent) {
    if (!trackEl || session.duration <= 0) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    scrubbing = true;
    timelineDrag.active = true;
    // Playing counts as "live" only when it isn't a preview blip from an
    // immediately preceding click/drag — else two quick paused-drags would
    // route to live seeks and strand the paused video playing.
    dragLive = session.playing && !session.previewing;
    trackEl.setPointerCapture(event.pointerId);
    clearTimeout(dragClearTimer);
    scrubX = event.clientX; // anchor at the pointer
    scrubLastX = event.clientX;
    const t = timeAt(scrubX);
    dragT = t;
    applyPointer(t);
  }

  function onTrackMove(event: PointerEvent) {
    if (!scrubbing) return;
    const t = scrubTimeAt(event);
    dragT = t;
    applyPointer(t);
  }

  function onTrackUp(event: PointerEvent) {
    if (!scrubbing) return;
    scrubbing = false;
    timelineDrag.active = false;
    cancelPending();
    // Finish where released (throttling may have swallowed the last move).
    // A paused drag ends as a final scrub so the preview pauses playback
    // again at the release point; a live drag ends as a plain seek.
    const t = scrubTimeAt(event);
    dragT = t;
    if (dragLive) session.seek(t);
    else session.scrub(t, settings.current.scrubPreviewMs);
    dragClearTimer = setTimeout(() => (dragT = null), 300);
    // Drop pointer-acquired focus so the slider's focus ring (which Chromium
    // shows on any focus for role="slider") doesn't linger after a scrub.
    // Keyboard focus is unaffected — Tab never fires pointerup.
    trackEl?.blur();
  }

  function onTrackCancel() {
    scrubbing = false;
    timelineDrag.active = false;
    cancelPending();
    clearTimeout(dragClearTimer);
    dragT = null;
    trackEl?.blur();
  }

  function onTrackKey(event: KeyboardEvent) {
    if (session.duration <= 0) return;
    const dir = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (dir === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastApply < SEEK_THROTTLE_MS) return; // key auto-repeat
    lastApply = now;
    // A twentieth of the visible window, capped at the 1s this has always been:
    // at full-track view that cap always binds, so nothing changes until you
    // zoom in, where a 1s nudge would jump most of the screen.
    const step = Math.min(1, Math.max(0.05, timelineView.span / 20));
    session.seek(session.t + dir * step);
  }

  // Wheel gestures. Ctrl/Cmd+wheel zooms around the pointer (a macOS trackpad
  // pinch arrives as a ctrlKey wheel, so it maps here for free); Shift+wheel or
  // a plain horizontal wheel pans. A plain vertical wheel is deliberately left
  // alone so the panel's own scroller keeps working.
  const LINE_PX = 40;
  const PAGE_PX = 800;

  function wheelDelta(event: WheelEvent): { x: number; y: number } {
    const k = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
    return { x: event.deltaX * k, y: event.deltaY * k };
  }

  /** Non-passive by construction: both handled branches must preventDefault —
   * the pan branch to stop the panel scrolling underneath, the zoom branch to
   * also suppress the browser's own ctrl+wheel page zoom. */
  function wheelZoom(node: HTMLElement): () => void {
    const onWheel = (event: WheelEvent) => {
      if (session.duration <= 0) return;
      const zooming = event.ctrlKey || event.metaKey;
      const d = wheelDelta(event);
      const panning = !zooming && (event.shiftKey || Math.abs(d.x) > Math.abs(d.y));
      if (!zooming && !panning) return;
      event.preventDefault();
      if (zooming) {
        // Exponential in the delta so a pinch composes: the same total travel
        // gives the same zoom however the browser chunks it into events.
        const factor = Math.min(4, Math.max(0.25, Math.pow(2, -d.y / ZOOM_DOUBLE_PX)));
        timelineView.zoomAround(timeAt(event.clientX), factor);
      } else {
        // Chrome puts Shift+wheel on deltaX, Firefox leaves it on deltaY.
        timelineView.panByPx(Math.abs(d.x) > Math.abs(d.y) ? d.x : d.y);
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }

  // Minimap drag. The viewbar is the only pointer affordance for panning that
  // doesn't need a modifier+wheel, so it drags: pointer travel maps 1:1 to the
  // thumb (whole-track px, not window px), and a press on the empty trough
  // recentres the window there before the drag continues from it.
  // $state because the viewbar only exists while zoomed, so this binding is
  // written and cleared as the element mounts and unmounts.
  let viewbarEl = $state<HTMLDivElement | undefined>(undefined);
  let viewbarDrag = $state(false);
  let viewbarLastX = 0;

  /** Pointer clientX → track time, in the viewbar's whole-track coordinates. */
  function viewbarTimeAt(clientX: number): number {
    if (!viewbarEl) return 0;
    const rect = viewbarEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * session.duration;
  }

  function onViewbarDown(event: PointerEvent) {
    if (!viewbarEl || timelineView.atFit) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); // don't let the press land on the lane below
    const t = viewbarTimeAt(event.clientX);
    if (!timelineView.contains(t)) timelineView.centerOn(t);
    viewbarDrag = true;
    viewbarLastX = event.clientX;
    viewbarEl.setPointerCapture(event.pointerId);
  }

  function onViewbarMove(event: PointerEvent) {
    if (!viewbarDrag) return;
    const dx = event.clientX - viewbarLastX;
    viewbarLastX = event.clientX;
    timelineView.panByTrackPx(dx);
  }

  function onViewbarUp() {
    viewbarDrag = false;
  }

  function onViewbarKey(event: KeyboardEvent) {
    const dir = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (dir === 0) return;
    event.preventDefault();
    event.stopPropagation();
    timelineView.panBy(dir * timelineView.span * 0.25); // a quarter window per press
  }

  // Auto-follow is the one thing here that can't be derived: paging the window
  // is a reaction to the engine's time stream, and where it lands depends on
  // where it was. Everything else about the zoomed view — the window, the
  // transform, the track-change reset — is $derived in timeline-view.
  // Not a rAF loop like ChordStrip: the window is static between page jumps, so
  // there is nothing to interpolate, just one comparison per tick.
  $effect(() => {
    const t = session.t;
    const playing = session.playing;
    const follow = uiPrefs.current.timelineFollow;
    // Never move the ground under a marker drag, a playhead scrub or a minimap
    // drag. (The minimap isn't in timelineDrag: that flag also raises the
    // "Hold Shift to fine-tune" hint, which the minimap doesn't honour.)
    const dragging = timelineDrag.active || viewbarDrag;
    untrack(() => timelineView.onTick(t, playing, follow, dragging));
  });

  /** Interpolate the playhead only where 30 Hz samples actually read as steps. */
  const smoothPlayhead = $derived(!timelineView.atFit && !scrubbing && dragT === null);

  // The wheel gestures, surfaced on the Looper title row while the pointer is
  // over the bar — the same slot the pins use for what *they* do. The toolbar
  // buttons and hotkeys are discoverable on their own; a wheel gesture is not,
  // and this puts the instruction where the gesture actually works. A Mac
  // trackpad pinch arrives as a ctrl-wheel, so it zooms with no modifier held.
  const gestureHint = IS_MAC
    ? 'Pinch or ⌘ + scroll to zoom · Shift + scroll to pan'
    : 'Ctrl + scroll to zoom · Shift + scroll to pan';
</script>

<div class="px-1 pt-1" {@attach wheelZoom}>
  <!-- 68px interactive lane: marker row 1 above, 4px track at 30px, row 2 below
       ending at 61px, then the 3px viewbar at 62px. MarkerPin's offsets match
       this geometry; the 3px tail below the viewbar is the room it thickens
       into on hover. -->
  <div
    id="timeline-lane"
    class="relative h-17"
    class:zoomed={!timelineView.atFit}
    bind:clientWidth={timelineView.laneW}
  >
    <!-- Zoom is a *wider inner element*, not a scale transform: everything below
         positions in % of it, so the playhead, loop band and pin math are the
         same at any zoom, and timeAt still reads the right rect off the track.
         A scaleX would stretch the pin dots and the 1–2px accents with it. -->
    <div
      class="inner"
      style:width={timelineView.atFit ? undefined : `${timelineView.zoom * 100}%`}
      style:transform={timelineView.atFit ? undefined : `translateX(${-timelineView.panPx}px)`}
    >
      <div
        class="track"
        class:scrubbing
        bind:this={trackEl}
        role="slider"
        tabindex="0"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={session.duration}
        aria-valuenow={session.t}
        aria-valuetext={formatClock(session.t)}
        onpointerdown={onTrackDown}
        onpointermove={onTrackMove}
        onpointerup={onTrackUp}
        onpointercancel={onTrackCancel}
        onkeydown={onTrackKey}
        onpointerenter={(e) => {
          if (e.pointerType === 'mouse') timelineDrag.hoverHint = gestureHint;
        }}
        onpointerleave={() => (timelineDrag.hoverHint = null)}
      >
        <div
          class="absolute top-0 bottom-0 left-0 rounded-[inherit] bg-accent-soft pointer-events-none"
          class:smooth={smoothPlayhead}
          style:width="{playPct}%"
        ></div>
      </div>
      {#if loopRegion}
        <div
          class="loop-region absolute top-6.5 h-3 rounded-[3px] pointer-events-none"
          style:left="{loopRegion.left}%"
          style:width="{loopRegion.width}%"
        ></div>
      {/if}
      <div
        class="absolute top-5.5 w-0.5 h-5 rounded-[1px] bg-accent -translate-x-1/2 pointer-events-none z-1"
        class:smooth={smoothPlayhead}
        style:left="{playPct}%"
      ></div>
      <!-- Virtual Start boundary: always shown (muted), fixed at the track start
           and numbered 0. Pickable as a loop-range endpoint, so it mirrors range
           state. End needs no pin — the last marker's section already runs to the
           track end. -->
      {#if session.duration > 0}
        {@const startId = markers.boundaryId('start')}
        <MarkerPin
          marker={{ id: startId, t: 0, label: '' }}
          index={0}
          above={false}
          boundary="start"
          boundaryName={uiPrefs.current.boundaryLabels.start || 'Start'}
          selectedRole={startId === markers.rangeStartId
            ? 'start'
            : startId === markers.rangeEndId
              ? 'end'
              : null}
          inRange={markers.inRange(startId)}
          hovered={false}
          dimmed={markers.hoveredId !== null}
          duration={session.duration}
          toTime={timeAt}
          onmove={() => {}}
          onjump={() => session.playFrom(0)}
        />
      {/if}
      <!-- Iterate insertion order, not sorted: re-sorting mid-drag would reorder
           the pin DOM nodes, and detaching a node releases its pointer capture,
           killing the drag the moment a marker crosses its neighbor. -->
      {#each markers.list as marker (marker.id)}
        {@const i = markers.indexOf(marker.id)}
        <MarkerPin
          {marker}
          index={i + 1}
          above={i % 2 === 0}
          selectedRole={marker.id === markers.rangeStartId
            ? 'start'
            : marker.id === markers.rangeEndId
              ? 'end'
              : null}
          inRange={markers.inRange(marker.id)}
          hovered={markers.hoveredId === marker.id}
          dimmed={markers.hoveredId !== null && markers.hoveredId !== marker.id}
          duration={session.duration}
          toTime={timeAt}
          onmove={(t) => markers.move(marker.id, t)}
          onjump={() => markers.playFrom(marker.id)}
          ondragstart={() => (timelineDrag.active = true)}
          ondragend={() => (timelineDrag.active = false)}
        />
      {/each}
    </div>
    <!-- The only chrome zoom adds: which slice of the track is on screen, in the
         3px strip at the bottom of the lane that nothing else occupies. Outside
         .inner, so it spans the whole track unzoomed — which is also what makes
         it draggable as a minimap. -->
    {#if !timelineView.atFit}
      <div
        class="viewbar"
        class:dragging={viewbarDrag}
        bind:this={viewbarEl}
        role="scrollbar"
        tabindex="0"
        aria-label="Timeline view position"
        aria-controls="timeline-lane"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(timelineView.startPct)}
        onpointerdown={onViewbarDown}
        onpointermove={onViewbarMove}
        onpointerup={onViewbarUp}
        onpointercancel={onViewbarUp}
        onkeydown={onViewbarKey}
        transition:fade={{ duration: 120 }}
      >
        <div
          class="thumb"
          style:left="{timelineView.startPct}%"
          style:width="{timelineView.spanPct}%"
        ></div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* The zoom viewport's content. At full-track view it is a plain box the size
     of the lane (no width/transform is emitted at all), so the timeline renders
     exactly as it did before zoom existed. */
  .inner {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 100%;
  }

  /* `clip` rather than `hidden` because hidden coerces the other axis to auto:
     the pins need to keep bleeding vertically (a selected dot's glow reaches
     ~8px above the row-1 dot, which sits 3px from the top). Only applied while
     zoomed, so at full-track view the track's focus ring can still overhang the
     lane's padding the way it always has. */
  .zoomed {
    overflow-x: clip;
    overflow-y: visible;
  }

  /* Panning rewrites only the transform (the width string is unchanged), so it
     costs no layout. */
  .zoomed .inner {
    will-change: transform;
  }

  /* Zoomed in, the playhead crosses the panel fast enough that 30 Hz engine
     ticks read as ~9px steps. One sample-interval of linear interpolation
     smooths that out; at full-track view the step is a fraction of a pixel and
     during a scrub the playhead must track the pointer exactly, so both cases
     leave this off. */
  .smooth {
    transition:
      left 34ms linear,
      width 34ms linear;
  }

  /* Which slice of the track is on screen, and the handle for moving it.
     Absolutely positioned, so appearing and disappearing never shifts the
     toolbar and chips below. */
  .viewbar {
    position: absolute;
    left: 0;
    right: 0;
    /* Top-anchored, 1px under where the row-2 pins end, with the rest of the
       lane left empty below it — that tail is what the hover growth expands
       into, so it thickens downwards and the pins never get crowded. */
    top: 62px;
    height: 3px;
    border-radius: var(--radius-pill);
    background: var(--track);
    opacity: 0.6;
    cursor: grab;
    touch-action: none;
    transition:
      height 120ms ease-out,
      opacity 120ms ease-out;
  }

  /* Taller invisible hit area, like the track's — 3px is far too thin to aim
     at. Reaches up to the row-2 pins (which sit at z-index 2, so it steals
     nothing from them) and down to the end of the lane. */
  .viewbar::before {
    content: '';
    position: absolute;
    inset: -4px 0 -3px 0;
  }

  /* Thickens on hover/focus/drag to read as a grabbable handle. Top-anchored
     and absolutely positioned, so it grows down into the empty tail of the lane
     rather than changing its height — nothing above or below moves. */
  .viewbar:hover,
  .viewbar:focus-visible,
  .viewbar.dragging {
    height: 6px;
    opacity: 1;
  }

  .viewbar.dragging {
    cursor: grabbing;
  }

  .viewbar:focus-visible {
    outline: 1px solid var(--accent-ink);
    outline-offset: 2px;
  }

  .viewbar .thumb {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 6px;
    border-radius: var(--radius-pill);
    background: var(--accent);
    opacity: 0.6;
    pointer-events: none;
  }

  .viewbar:hover .thumb,
  .viewbar:focus-visible .thumb,
  .viewbar.dragging .thumb {
    opacity: 1;
  }

  /* Loop range band: a filled amber region with a defined outline and edge
     accents so the active loop reads as a distinct span, not a faint tint. */
  .loop-region {
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    border-left: 2px solid var(--accent);
    border-right: 2px solid var(--accent);
    box-shadow: 0 0 0 1px var(--accent-softer);
  }

  .track {
    position: absolute;
    top: 30px;
    left: 0;
    right: 0;
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--track);
    cursor: pointer;
    touch-action: none;
  }

  /* Taller invisible hit area so the 4px bar is easy to click. */
  .track::before {
    content: '';
    position: absolute;
    inset: -9px 0;
  }

  .track:focus-visible {
    outline: 1px solid var(--accent-ink);
    outline-offset: 5px;
  }

  /* No ring during a pointer scrub/fine-tune — only keyboard focus should
     surface the slider outline (see trackEl.blur() on release). */
  .track.scrubbing:focus-visible {
    outline: none;
  }
</style>
