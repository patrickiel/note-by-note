<script lang="ts">
  import { formatClock } from '@/core/model/format';
  import { markers } from '@/features/markers/panel/markers.svelte';
  import { session } from '@/core/state/session.svelte';
  import { settings, uiPrefs } from '@/features/settings/panel/settings.svelte';
  import { timelineDrag } from './timeline-drag.svelte';
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
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastApply < SEEK_THROTTLE_MS) return; // key auto-repeat
    lastApply = now;
    session.seek(session.t + step);
  }
</script>

<div class="px-1 pt-1">
  <!-- 64px interactive lane: marker row 1 above, 4px track at 30px, row 2 below.
       MarkerPin's offsets match this geometry. -->
  <div class="relative h-16">
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
    >
      <div class="absolute top-0 bottom-0 left-0 rounded-[inherit] bg-accent-soft pointer-events-none" style:width="{playPct}%"></div>
    </div>
    {#if loopRegion}
      <div
        class="loop-region absolute top-6.5 h-3 rounded-[3px] pointer-events-none"
        style:left="{loopRegion.left}%"
        style:width="{loopRegion.width}%"
      ></div>
    {/if}
    <div class="absolute top-5.5 w-0.5 h-5 rounded-[1px] bg-accent -translate-x-1/2 pointer-events-none z-1" style:left="{playPct}%"></div>
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
</div>

<style>
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
