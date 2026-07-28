<script lang="ts">
  import { formatPrecise } from '@/core/model/format';
  import type { Marker } from '@/core/model/types';
  import { timelineDrag } from '@/ui/timeline/timeline-drag.svelte';

  /** Pointer must travel this far (px) before a press becomes a drag. */
  const DRAG_THRESHOLD = 3;
  /** Pointer travel is scaled by this while Shift is held (10× finer). */
  const FINE_FACTOR = 0.1;

  let {
    marker,
    index,
    above,
    selectedRole,
    inRange,
    hovered,
    dimmed,
    duration,
    toTime,
    onmove,
    onjump,
    ondragstart,
    ondragend,
    boundary,
    boundaryName,
  }: {
    marker: Marker;
    /** 1-based display number (markers are auto-sorted by time). */
    index: number;
    /** Row 1 (circle above the bar) vs row 2 (below). */
    above: boolean;
    /** Highlighted as the selected loop-range start/end marker. */
    selectedRole: 'start' | 'end' | null;
    /** Inside the selected loop range (endpoints included) — softer highlight. */
    inRange: boolean;
    /** Highlighted while its chip/row is hovered in the marker list. */
    hovered: boolean;
    /** Faded because a *different* marker's chip/row is hovered. */
    dimmed: boolean;
    /** Track duration in seconds, for horizontal positioning. */
    duration: number;
    /** Converts a pointer clientX to a track time (owned by Timeline). */
    toTime: (clientX: number) => number;
    /** Fired live while the pin is dragged along the bar. */
    onmove: (t: number) => void;
    /** Fired on click without drag. */
    onjump: () => void;
    /** Fired once when a drag begins (after crossing the drag threshold). */
    ondragstart?: () => void;
    /** Fired once when a drag ends (pointer release or cancel). */
    ondragend?: () => void;
    /** When set, this pin is a virtual track boundary (Start/End): muted, fixed
     * in place (not draggable), and a click seeks there instead of dragging. */
    boundary?: 'start' | 'end';
    /** Resolved boundary display name for the a11y label (may be customized). */
    boundaryName?: string;
  } = $props();

  const pct = $derived(
    duration > 0 ? Math.min(100, Math.max(0, (marker.t / duration) * 100)) : 0,
  );

  const roleSuffix = $derived(
    selectedRole === 'start' ? ', loop start' : selectedRole === 'end' ? ', loop end' : '',
  );

  /** Hover hint surfaced on the Looper title row (mirrors the drag hint). */
  const hint = $derived(boundary ? 'Click to jump' : 'Click to jump · drag to move');

  /** Screen-reader label only — the pins carry no tooltip; what they do shows up
   * in the Looper title row on hover instead. */
  const label = $derived(
    boundary
      ? `${boundaryName || (boundary === 'start' ? 'Start' : 'End')} — ${formatPrecise(marker.t)}${roleSuffix}`
      : `Marker ${index}${marker.label ? ` (${marker.label})` : ''} — ${formatPrecise(marker.t)}${roleSuffix}`,
  );

  /** Horizontal drag with pointer capture; a press that moves less than
   * DRAG_THRESHOLD stays a click (→ onjump, also keyboard-activatable). */
  function drag(node: HTMLButtonElement): () => void {
    let pointerId: number | null = null;
    let startX = 0;
    let dragged = false;
    // Effective clientX fed to toTime. Tracks the pointer 1:1 during a normal
    // drag; advances by FINE_FACTOR·Δ while Shift is held, so toggling Shift
    // mid-drag re-gears the motion without the marker jumping.
    let virtualX = 0;
    let lastX = 0;

    const advance = (event: PointerEvent) => {
      const dx = event.clientX - lastX;
      lastX = event.clientX;
      virtualX += event.shiftKey ? dx * FINE_FACTOR : dx;
    };

    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.stopPropagation();
      pointerId = event.pointerId;
      startX = event.clientX;
      dragged = false;
      node.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (!dragged) {
        if (Math.abs(event.clientX - startX) < DRAG_THRESHOLD) return;
        dragged = true;
        node.classList.add('dragging');
        virtualX = event.clientX; // anchor at the pointer on first real move
        lastX = event.clientX;
        ondragstart?.();
        onmove(toTime(virtualX));
        return;
      }
      advance(event);
      onmove(toTime(virtualX));
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (dragged) {
        advance(event);
        onmove(toTime(virtualX));
        node.classList.remove('dragging');
        ondragend?.();
      }
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (dragged) {
        node.classList.remove('dragging');
        ondragend?.();
      }
      dragged = false;
    };
    const click = (event: MouseEvent) => {
      event.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      onjump();
    };

    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('click', click);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', click);
    };
  }
</script>

<!-- Geometry matches Timeline's 64px lane with the 4px track at top: 30px. -->
<div
  class={['pin', above ? 'above' : 'below', {
    boundary,
    hovered,
    dimmed,
    selected: selectedRole !== null,
    'in-range': inRange && selectedRole === null,
  }]}
  style:left="{pct}%"
>
  <span class="stem"></span>
  <!-- Boundaries are fixed, so they skip the drag attachment and seek on click;
       real markers drag along the bar (the drag also handles their click). -->
  <button
    type="button"
    class={['dot', { boundary }]}
    aria-label={label}
    onclick={boundary ? onjump : undefined}
    onpointerenter={(e) => {
      if (e.pointerType === 'mouse') timelineDrag.hoverHint = hint;
    }}
    onpointerleave={() => (timelineDrag.hoverHint = null)}
    {@attach boundary == null && drag}
  >
    {index}
  </button>
</div>

<style>
  .pin {
    position: absolute;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    z-index: 2;
  }

  /* DOM order is stem→dot; reversing puts the circle on top for row 1. */
  .pin.above {
    top: 3px;
    flex-direction: column-reverse;
  }

  .pin.below {
    top: 34px;
  }

  .stem {
    width: 1px;
    height: 9px;
    background: var(--accent);
    opacity: 0.6;
    pointer-events: none;
  }

  .dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  .dot:hover {
    background: var(--accent-hover);
  }

  .dot:global(.dragging) {
    cursor: grabbing;
  }

  /* Virtual boundaries (Start/End) read as muted, fixed reference points, not
     user markers. Circle background matches the boundary badge in the marker
     list below (var(--text-faint)); the stem is muted to match. */
  .pin.boundary .stem {
    background: var(--text-faint);
  }

  .dot.boundary,
  .dot.boundary:active {
    background: var(--text-faint);
    cursor: pointer;
  }

  .dot.boundary:hover {
    background: var(--text-muted);
  }

  .pin.selected .dot {
    box-shadow:
      0 0 0 2px var(--bg-panel),
      0 0 0 3.5px var(--accent),
      0 0 10px 3px var(--accent-soft);
  }

  .pin.in-range .dot {
    box-shadow:
      0 0 0 2px var(--bg-panel),
      0 0 0 3.5px color-mix(in srgb, var(--accent) 45%, transparent);
  }

  /* Hover mirroring: the matching pin pops while the rest fade back, so the
     link between a list tile and its pin reads at a glance. */
  .pin {
    transition: opacity 0.12s ease;
  }

  .pin.dimmed {
    opacity: 0.3;
  }

  /* Mirror of a hovered chip/row in the marker list. Sits below the stronger
     selected/in-range rings so those still read when both apply. */
  .pin.hovered .dot {
    background: var(--accent-hover);
    box-shadow:
      0 0 0 2px var(--bg-panel),
      0 0 0 3.5px var(--accent-soft);
  }

</style>
