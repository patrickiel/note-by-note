<script lang="ts">
  /** The single tooltip bubble for the panel — mount once, at the app root.
   * Fixed-positioned so it escapes the panel body's `overflow: hidden`, and
   * `pointer-events: none` so it can never eat a click on what it covers. */
  import { activeCombo, comboChips } from './hotkey';
  import { tooltips } from './tooltip.svelte';

  /** Anchor edge → bubble, leaving room for the arrow. */
  const GAP = 9;
  /** Keep-out margin at the viewport edges. */
  const EDGE = 8;
  /** Closest the arrow may sit to a bubble corner, so it stays on the radius. */
  const ARROW_INSET = 14;

  let bubble = $state<HTMLElement | null>(null);
  let left = $state(0);
  let top = $state(0);
  let arrowX = $state(0);
  let side = $state<'top' | 'bottom'>('bottom');
  /** Set one frame after mount so the open transition actually runs. */
  let shown = $state(false);

  const chips = $derived(comboChips(activeCombo(tooltips.action, tooltips.keys)));

  function place(anchor: HTMLElement, el: HTMLElement) {
    const a = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // The anchor can scroll out from under a live tooltip.
    if (a.bottom < 0 || a.top > vh) {
      tooltips.dismiss();
      return;
    }

    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = a.bottom + GAP;
    const above = a.top - GAP - h;

    // Below unless it would run off the bottom and there is room above.
    let next = tooltips.placement;
    if (next === 'bottom' && below + h > vh - EDGE && above >= EDGE) next = 'top';
    else if (next === 'top' && above < EDGE && below + h <= vh - EDGE) next = 'bottom';
    side = next;
    top = Math.round(next === 'bottom' ? below : above);

    // Centre on the anchor, then clamp; the arrow keeps pointing at the anchor
    // even after the bubble slides away from centre at a viewport edge.
    const centre = a.left + a.width / 2;
    const maxLeft = Math.max(EDGE, vw - EDGE - w);
    left = Math.round(Math.min(Math.max(centre - w / 2, EDGE), maxLeft));
    arrowX = Math.round(
      Math.min(Math.max(centre - left, ARROW_INSET), Math.max(ARROW_INSET, w - ARROW_INSET)),
    );
  }

  $effect(() => {
    const anchor = tooltips.anchor;
    const el = bubble;
    // Re-measure whenever the content can change the bubble's size.
    void tooltips.text;
    void tooltips.placement;
    void chips.length;
    if (!anchor || !el) return;

    const reposition = () => place(anchor, el);
    reposition();
    // Capture phase: the panel body scrolls, not the window.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  });

  $effect(() => {
    if (!tooltips.anchor) {
      shown = false;
      return;
    }
    // Moving between anchors keeps `shown` true, so a scan across a button row
    // repositions instead of re-fading at every stop.
    const frame = requestAnimationFrame(() => (shown = true));
    return () => cancelAnimationFrame(frame);
  });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && tooltips.dismiss()} />

{#if tooltips.anchor && tooltips.text}
  <div
    bind:this={bubble}
    class={['tip', side, { shown }]}
    style:left="{left}px"
    style:top="{top}px"
    style:--arrow-x="{arrowX}px"
    role="tooltip"
    aria-hidden="true"
  >
    <span class="label">{tooltips.text}</span>
    {#if chips.length}
      <span class="keys">
        {#each chips as chip, i (i)}<kbd>{chip}</kbd>{/each}
      </span>
    {/if}
    <span class="arrow"></span>
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(240px, calc(100vw - 24px));
    padding: 5px 8px;
    background: var(--bg-panel-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow);
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--text);
    text-align: left;
    pointer-events: none;
    opacity: 0;
  }

  /* Slides in *from* the anchor, so the motion reads as "this belongs to that".
     Declared before `.shown` — same specificity, so source order decides. */
  .tip.bottom {
    transform: translateY(-3px);
  }
  .tip.top {
    transform: translateY(3px);
  }

  .tip.shown {
    opacity: 1;
    transform: none;
    transition:
      opacity 110ms ease-out,
      transform 110ms ease-out;
  }

  .label {
    min-width: 0;
  }

  .keys {
    flex: none;
    display: flex;
    gap: 3px;
  }

  kbd {
    display: block;
    min-width: 16px;
    padding: 0 4px;
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 15px;
    text-align: center;
    color: var(--text-muted);
    background: var(--bg-inset);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    white-space: nowrap;
  }

  /* Rotated square; only the two edges facing away from the bubble are drawn,
     so it reads as a continuation of the border rather than a diamond. */
  .arrow {
    position: absolute;
    left: var(--arrow-x);
    width: 8px;
    height: 8px;
    margin-left: -4px;
    background: var(--bg-panel-2);
    transform: rotate(45deg);
  }

  .tip.bottom .arrow {
    top: -5px;
    border-top: 1px solid var(--border-strong);
    border-left: 1px solid var(--border-strong);
  }

  .tip.top .arrow {
    bottom: -5px;
    border-bottom: 1px solid var(--border-strong);
    border-right: 1px solid var(--border-strong);
  }
</style>
