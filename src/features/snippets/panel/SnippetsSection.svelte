<script lang="ts">
  import SnippetCard from '@/features/snippets/panel/SnippetCard.svelte';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import Section from '@/ui/Section.svelte';
  import { snippets } from '@/features/snippets/panel/snippets.svelte';
  import { markers } from '@/features/markers/panel/markers.svelte';
  import { session } from '@/core/state/session.svelte';

  const mode = $derived(session.loop.mode);
  /** Range the add button saves: picked markers, else the active loop range. */
  const snippetRange = $derived(
    markers.range ?? (mode?.kind === 'range' ? { startT: mode.startT, endT: mode.endT } : null),
  );

  function addSnippet() {
    if (snippetRange) snippets.addFromRange(snippetRange.startT, snippetRange.endT);
  }

  const GAP = 8; // matches the flex `gap-2` between slots

  let listEl = $state<HTMLDivElement | null>(null);
  /** Index of the card being dragged, null when idle. Fixed for the gesture —
   * the store isn't reordered until drop, so slot indices stay stable. */
  let dragIndex = $state<number | null>(null);
  /** Index the dragged card would land at, as the pointer moves. */
  let dragDrop = $state(0);
  /** translateY applied to the dragged card so it shadows the cursor. */
  let dragDy = $state(0);
  /** Height of the dragged card = the gap the other cards slide to fill. */
  let dragHeight = $state(0);
  /** Frozen slot geometry captured at drag start (viewport coords). */
  let layout: { top: number; height: number }[] = [];
  /** Suppresses the slide transition on the commit frame so the reordered
   * cards snap to their final spots instead of bouncing back from the drag. */
  let settling = $state(false);

  /** Transform for slot `i` during a drag: the held card follows the cursor,
   * the cards between its origin and target slide by one card-height to open
   * the landing gap. */
  function slotTransform(i: number): string {
    if (dragIndex === null) return '';
    if (i === dragIndex) return `translateY(${dragDy}px)`;
    const shift = dragHeight + GAP;
    if (dragDrop > dragIndex && i > dragIndex && i <= dragDrop) return `translateY(${-shift}px)`;
    if (dragDrop < dragIndex && i >= dragDrop && i < dragIndex) return `translateY(${shift}px)`;
    return '';
  }

  /** Drag-reorder via pointer events on the card's handle (no HTML5 DnD). */
  function startDrag(index: number, event: PointerEvent) {
    if (snippets.list.length < 2 || !listEl) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();

    const slots = Array.from(listEl.children) as HTMLElement[];
    layout = slots.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    const n = layout.length;
    const grabWithin = event.clientY - layout[index].top;
    const first = layout[0].top;
    const last = layout[n - 1].top + layout[n - 1].height;

    dragIndex = index;
    dragDrop = index;
    dragHeight = layout[index].height;
    dragDy = 0;

    const handle = event.currentTarget;
    if (handle instanceof Element) {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Pointer already gone — window listeners still cover the gesture.
      }
    }

    const onMove = (e: PointerEvent) => {
      if (dragIndex === null) return;
      const projTop = Math.max(first, Math.min(e.clientY - grabWithin, last - dragHeight));
      dragDy = projTop - layout[index].top;
      const center = projTop + dragHeight / 2;
      let drop = index;
      // Cross only ~1/3 into a neighbour to claim its slot, so cards yield early.
      for (let j = index + 1; j < n; j++) {
        if (center > layout[j].top + layout[j].height * 0.35) drop = j;
      }
      for (let j = index - 1; j >= 0; j--) {
        if (center < layout[j].top + layout[j].height * 0.65) drop = j;
      }
      dragDrop = drop;
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      settling = true;
      if (dragIndex !== null && dragDrop !== index) snippets.reorder(index, dragDrop);
      dragIndex = null;
      // Re-enable transitions once the un-transformed layout has painted.
      requestAnimationFrame(() => requestAnimationFrame(() => (settling = false)));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }
</script>

<Section id="snippets" label="Snippets">
  <!-- Control bar: snippet-wide actions, pinned below the header. -->
  <div class="surface flex items-center gap-0.5 p-1.5 mb-2">
    <IconButton
      icon="plus"
      label="Add snippet from selected range"
      action="addSnippet"
      disabled={snippetRange === null}
      onclick={addSnippet}
    />
    <IconButton
      icon="loop"
      label="Repeat sequence"
      active={snippets.sequenceLoop}
      onclick={() => snippets.toggleSequenceLoop()}
    />
    <IconButton
      icon="clock"
      label="Count-in"
      active={snippets.sequenceCountIn}
      onclick={() => snippets.toggleSequenceCountIn()}
    />
  </div>

  {#if snippets.list.length === 0}
    <p class="my-1 text-center text-faint text-[12px]">
      Select a range and press the add button to save a snippet
    </p>
  {:else}
    <div class="flex flex-col gap-2" bind:this={listEl}>
      {#each snippets.list as snippet, i (snippet.id)}
        <div
          class={['slot', { dragging: dragIndex === i, settling }]}
          style:transform={slotTransform(i)}
        >
          <SnippetCard {snippet} index={i + 1} onreorderstart={(event) => startDrag(i, event)} />
        </div>
      {/each}
    </div>
  {/if}
</Section>

<style>
  .slot {
    position: relative;
    border-radius: var(--radius);
    /* Non-dragged cards ease into their new spot; the dragged one opts out. */
    transition: transform 170ms cubic-bezier(0.2, 0, 0, 1);
  }

  .slot.settling {
    transition: none;
  }

  .slot.dragging {
    z-index: 5;
    transition: none;
    outline: 1px solid var(--accent-ink);
    box-shadow: var(--shadow);
  }
</style>
