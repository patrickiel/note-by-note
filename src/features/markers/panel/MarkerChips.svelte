<script lang="ts">
  import EditableText from '@/ui/shared/EditableText.svelte';
  import Icon from '@/ui/shared/Icon.svelte';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { formatPrecise, parseTime } from '@/core/model/format';
  import { markers } from '@/features/markers/panel/markers.svelte';
  import { session } from '@/core/state/session.svelte';
  import { uiPrefs } from '@/features/settings/panel/settings.svelte';

  const blocksView = $derived(uiPrefs.current.markerView === 'blocks');

  // The virtual Start boundary is the only reference tile: it loops the first
  // section (track start → marker 1). There's no End tile — the last marker's
  // own section already runs to the track end, so a separate End is redundant.
  const startId = markers.boundaryId('start');
  const startLabel = $derived(uiPrefs.current.boundaryLabels.start || 'Start');

  function hoverOn(id: string) {
    markers.hoveredId = id;
  }

  function hoverOff() {
    markers.hoveredId = null;
  }

  // ── Selecting a loop range ──────────────────────────────────────
  // A plain click on a tile loops its section (that marker → the next one).
  // Two ways to span several sections: press on one tile and release on
  // another, or click one tile and Shift-click another (the anchor is the last
  // tile clicked, so successive Shift-clicks re-span from it). Edit mode opts
  // out (its tiles jump/edit instead). Start takes part like any tile; it
  // begins the first section.

  let dragAnchorId: string | null = $state(null);
  let dragOverId: string | null = $state(null);
  /** Last plainly-clicked tile — the fixed end of a Shift-click span. */
  let anchorId: string | null = $state(null);
  let shiftHeld = $state(false);
  /** Tile the pointer is over — gates the hint line and, with Shift held, gives
   * the Shift-click span the same live preview the drag gets. */
  let hoverTileId: string | null = $state(null);
  // Set when a drag committed a range, so the trailing click (touch can still
  // synthesize one) doesn't also fire the single-section pick.
  let suppressClick = false;

  /** The tile id an element sits in, if any. */
  function tileIdOf(node: EventTarget | null): string | null {
    if (!(node instanceof Element)) return null;
    return node.closest<HTMLElement>('[data-tile-id]')?.dataset.tileId ?? null;
  }

  /** The tile id under a viewport point, or null when the point misses them. */
  function tileIdAt(x: number, y: number): string | null {
    return tileIdOf(document.elementFromPoint(x, y));
  }

  function tileDown(id: string) {
    dragAnchorId = id;
    dragOverId = id;
    suppressClick = false;
  }

  function tileMove(e: PointerEvent) {
    if (dragAnchorId === null) return;
    const over = tileIdAt(e.clientX, e.clientY);
    if (over !== null) dragOverId = over;
  }

  // Delegated hover tracking for every tile, Start included. `pointerout` is
  // what catches the pointer leaving the tiles altogether (straight out of the
  // panel included) — `pointerover` alone would leave the last tile latched.
  function hoverProbe(e: PointerEvent) {
    hoverTileId = tileIdOf(e.target);
  }

  function hoverOut(e: PointerEvent) {
    if (tileIdOf(e.relatedTarget) === null) hoverTileId = null;
  }

  function keyDown(e: KeyboardEvent) {
    if (e.key === 'Shift') shiftHeld = true;
  }

  function keyUp(e: KeyboardEvent) {
    if (e.key === 'Shift') shiftHeld = false;
  }

  // Window blur too: a Shift release that lands in another window never reaches
  // us, which would leave the preview stuck on.
  function clearShift() {
    shiftHeld = false;
  }

  function tileUp(e: PointerEvent) {
    if (dragAnchorId === null) return;
    const anchor = dragAnchorId;
    const over = tileIdAt(e.clientX, e.clientY) ?? dragOverId;
    dragAnchorId = null;
    dragOverId = null;
    // Released on a different tile → span the two. Same tile falls through to
    // the click handler (loop just that section).
    if (over !== null && over !== anchor) {
      suppressClick = markers.selectRangeBetween(anchor, over);
      if (suppressClick) anchorId = anchor;
    }
  }

  function tileCancel() {
    dragAnchorId = null;
    dragOverId = null;
  }

  function clickTile(id: string, e: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    // Shift-click: span from the last clicked tile to this one instead of
    // looping a single section. Keeps the anchor, so the next Shift-click
    // re-spans from the same place. With no anchor yet it's a plain click.
    if (e.shiftKey && anchorId !== null && anchorId !== id) {
      if (markers.selectRangeBetween(anchorId, id)) return;
    }
    anchorId = id;
    markers.playSectionFrom(id);
  }

  /** The two tiles the pending selection spans — the drag in flight, else the
   * tile Shift-hovered against the anchor. */
  const previewPair = $derived.by((): [string, string] | null => {
    if (dragAnchorId !== null && dragOverId !== null) return [dragAnchorId, dragOverId];
    if (shiftHeld && anchorId !== null && hoverTileId !== null) return [anchorId, hoverTileId];
    return null;
  });

  // Live preview span — the same section-aware range the gesture would commit
  // (each tile's section included; end-exclusive highlight).
  const previewRange = $derived.by(() => {
    if (previewPair === null || previewPair[0] === previewPair[1]) return null;
    return markers.spanRange(previewPair[0], previewPair[1]);
  });

  /** Whether a tile shows the range highlight: the pending preview while a
   * gesture is in flight, otherwise the committed range (both end-exclusive). */
  function tileRanged(id: string, t: number): boolean {
    if (previewRange) return t >= previewRange.startT && t < previewRange.endT;
    return markers.inRangeExclEnd(id);
  }

  /** The hint only speaks up while the pointer rests on a tile and no selection
   * is being dragged out. Edit mode has nothing to say — its tiles don't select
   * ranges — and with no markers yet there's only Start, so no range to span. */
  const showHint = $derived(
    !markers.editMode &&
      markers.sorted.length > 0 &&
      hoverTileId !== null &&
      previewRange === null,
  );

  function commitTime(id: string, text: string): boolean {
    const t = parseTime(text);
    if (t === null) return false;
    markers.move(id, t);
    return true;
  }
</script>

<svelte:window
  onpointermove={tileMove}
  onpointerup={tileUp}
  onpointercancel={tileCancel}
  onkeydown={keyDown}
  onkeyup={keyUp}
  onblur={clearShift}
/>

<!-- Virtual Start boundary — always shown, never persisted, excluded from
     numbering but numbered as 0 alongside the markers. It loops the first
     section like a marker; its label defaults to "Start" but can be renamed. -->

<!-- Start badge contents: the "0" position number with a play glyph that fades
     in on hover, mirroring the numbered-marker badge so Start reads as
     "marker 0". -->
{#snippet startDigit()}
  <span class="num">0</span>
  <span class="play"><Icon name="play" size={11} /></span>
{/snippet}

{#snippet startHead()}
  <button
    type="button"
    class={['index', 'index-btn', 'boundary-index']}
    aria-label={`Jump to ${startLabel} of track`}
    onclick={() => session.seek(0)}
    {@attach tooltip(`Jump to ${startLabel}`)}
  >
    {@render startDigit()}
  </button>
{/snippet}

{#snippet startLabelField()}
  <EditableText
    value={startLabel}
    placeholder="Start"
    label="Rename Start marker"
    readonly={!markers.editMode}
    oncommit={(text) => uiPrefs.setBoundaryLabel('start', text)}
  />
{/snippet}

<!-- A static badge for the whole-tile button variant: the enclosing tile is the
     button, so this can't be one itself. -->
{#snippet startBadge()}
  <span class="index boundary-index">{@render startDigit()}</span>
{/snippet}

{#snippet startChip()}
  {#if markers.editMode}
    <div class={['chip', 'boundary', { ranged: tileRanged(startId, 0) }]}>
      <div class="chip-head">
        {@render startHead()}
        <span class="chip-label">{@render startLabelField()}</span>
      </div>
      <span class="time">{formatPrecise(0)}</span>
    </div>
  {:else}
    <button
      type="button"
      class={['chip', 'chip-btn', 'boundary', { ranged: tileRanged(startId, 0) }]}
      data-tile-id={startId}
      aria-label={`Play and loop section from ${startLabel}`}
      onpointerdown={() => tileDown(startId)}
      onclick={(e) => clickTile(startId, e)}
    >
      <span class="chip-head">
        {@render startBadge()}
        <span class="chip-label">{startLabel}</span>
      </span>
      <span class="time">{formatPrecise(0)}</span>
    </button>
  {/if}
{/snippet}

{#snippet startRow()}
  {#if markers.editMode}
    <li class={['row', 'boundary', { ranged: tileRanged(startId, 0) }]}>
      {@render startHead()}
      <span class="label">{@render startLabelField()}</span>
      <span class="time">{formatPrecise(0)}</span>
      <!-- Start has no set/delete actions of its own; this stands in for them so
           the row keeps the marker rows' height and time column. -->
      <span class="actions-spacer" aria-hidden="true"></span>
    </li>
  {:else}
    <li>
      <button
        type="button"
        class={['row', 'row-btn', 'boundary', { ranged: tileRanged(startId, 0) }]}
        data-tile-id={startId}
        aria-label={`Play and loop section from ${startLabel}`}
        onpointerdown={() => tileDown(startId)}
        onclick={(e) => clickTile(startId, e)}
      >
        {@render startBadge()}
        <span class="label">{startLabel}</span>
        <span class="time">{formatPrecise(0)}</span>
      </button>
    </li>
  {/if}
{/snippet}

<!-- Hint line above the tiles. Range-selecting isn't discoverable from the
     tiles themselves, so spell it out — but only while the pointer rests on a
     tile, and never mid-gesture, where the tiles' own highlight already shows
     what's being selected. The row keeps its height throughout, so the tiles
     never shift as the line comes and goes. -->
{#snippet hint()}
  <p class={['hint', { shown: showHint }]}>
    Drag or <kbd>Shift</kbd>+click to select a range
  </p>
{/snippet}

<div
  class="tiles"
  role="presentation"
  onpointerover={hoverProbe}
  onpointerout={hoverOut}
>
  {@render hint()}

  {#if blocksView}
    <div class="grid">
      {@render startChip()}
      {#each markers.sorted as marker, i (marker.id)}
        <!-- Outside edit mode the whole chip is the target: a click loops the
             section from this marker to the next; a drag onto another tile spans
             to it. Edit mode keeps its own layout, where the badge jumps. -->
        {#if !markers.editMode}
          <button
            type="button"
            class={['chip', 'chip-btn', { ranged: tileRanged(marker.id, marker.t) }]}
            data-tile-id={marker.id}
            aria-label="Marker {i + 1}: play and loop this section"
            onpointerdown={() => tileDown(marker.id)}
            onclick={(e) => clickTile(marker.id, e)}
            onmouseenter={() => hoverOn(marker.id)}
            onmouseleave={hoverOff}
          >
            <span class="chip-head">
              <span class="index">
                <span class="num">{i + 1}</span>
                <span class="play"><Icon name="play" size={11} /></span>
              </span>
              {#if marker.label}
                <span class="chip-label">{marker.label}</span>
              {/if}
            </span>
            <span class="time">{formatPrecise(marker.t)}</span>
          </button>
        {:else}
          <div
            class={['chip', { ranged: tileRanged(marker.id, marker.t) }]}
            role="presentation"
            onmouseenter={() => hoverOn(marker.id)}
            onmouseleave={hoverOff}
          >
            <div class="chip-head">
              <button
                type="button"
                class={['index', 'index-btn']}
                aria-label="Marker {i + 1}: jump to position"
                onclick={() => markers.jumpTo(marker.id)}
                {@attach tooltip(`Jump to marker ${i + 1}`)}
              >
                <span class="num">{i + 1}</span>
                <span class="play"><Icon name="play" size={11} /></span>
              </button>
              <span class="chip-label">
                <EditableText
                  value={marker.label}
                  placeholder="Marker {i + 1}"
                  label="Rename marker {i + 1}"
                  readonly={!markers.editMode}
                  oncommit={(text) => markers.rename(marker.id, text)}
                />
              </span>
            </div>
            <span class="time">
              <EditableText
                mono
                value={formatPrecise(marker.t)}
                label="Marker {i + 1} timestamp"
                readonly={!markers.editMode}
                oncommit={(text) => commitTime(marker.id, text)}
              />
            </span>
            {#if markers.editMode}
              <div class="chip-actions">
                <IconButton
                  icon="bookmark"
                  size={15}
                  label="Set marker {i + 1} to playhead"
                  onclick={() => markers.setToPlayhead(marker.id)}
                />
                <IconButton
                  icon="trash"
                  size={15}
                  danger
                  label="Delete marker {i + 1}"
                  onclick={() => markers.remove(marker.id)}
                />
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {:else}
    <ul class="rows">
      {@render startRow()}
      {#each markers.sorted as marker, i (marker.id)}
        <!-- Outside edit mode the whole row is the target: a click loops the
             section from this marker to the next; a drag onto another tile spans
             to it. Edit mode keeps its own layout, where the badge jumps. -->
        {#if !markers.editMode}
          <li>
            <button
              type="button"
              class={['row', 'row-btn', { ranged: tileRanged(marker.id, marker.t) }]}
              data-tile-id={marker.id}
              aria-label="Marker {i + 1}: play and loop this section"
              onpointerdown={() => tileDown(marker.id)}
              onclick={(e) => clickTile(marker.id, e)}
              onmouseenter={() => hoverOn(marker.id)}
              onmouseleave={hoverOff}
            >
              <span class="index">
                <span class="num">{i + 1}</span>
                <span class="play"><Icon name="play" size={11} /></span>
              </span>
              <span class={['label', { faint: !marker.label, mono: !!marker.label }]}>
                {marker.label || `Marker ${i + 1}`}
              </span>
              <span class="time">{formatPrecise(marker.t)}</span>
            </button>
          </li>
        {:else}
          <li
            class={['row', { ranged: tileRanged(marker.id, marker.t) }]}
            role="presentation"
            onmouseenter={() => hoverOn(marker.id)}
            onmouseleave={hoverOff}
          >
            <button
              type="button"
              class={['index', 'index-btn']}
              aria-label="Marker {i + 1}: jump to position"
              onclick={() => markers.jumpTo(marker.id)}
              {@attach tooltip(`Jump to marker ${i + 1}`)}
            >
              <span class="num">{i + 1}</span>
              <span class="play"><Icon name="play" size={11} /></span>
            </button>
            <span class="label">
              <EditableText
                value={marker.label}
                placeholder="Marker {i + 1}"
                label="Rename marker {i + 1}"
                readonly={!markers.editMode}
                oncommit={(text) => markers.rename(marker.id, text)}
              />
            </span>
            <span class="time">
              <EditableText
                mono
                value={formatPrecise(marker.t)}
                label="Marker {i + 1} timestamp"
                readonly={!markers.editMode}
                oncommit={(text) => commitTime(marker.id, text)}
              />
            </span>
            {#if markers.editMode}
              <IconButton
                icon="bookmark"
                size={15}
                label="Set marker {i + 1} to playhead"
                onclick={() => markers.setToPlayhead(marker.id)}
              />
              <IconButton
                icon="trash"
                size={15}
                danger
                label="Delete marker {i + 1}"
                onclick={() => markers.remove(marker.id)}
              />
            {/if}
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* ── Hint line ───────────────────────────────────────────── */

  .tiles {
    display: flex;
    flex-direction: column;
    gap: 6px;
    /* The hint sits closer to the tiles it describes than to the toolbar above,
       so claw back part of the card's own row gap. */
    margin-top: -6px;
  }

  .hint {
    margin: 0;
    /* Reserved height: the line fades in and out on hover, and the tiles below
       must not move when it does. */
    height: 16px;
    font-size: 11px;
    line-height: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-muted);
    user-select: none;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }

  .hint.shown {
    opacity: 1;
  }

  /* Key chip — same spec as the tooltip layer's shortcut chips, laid out inline
     here instead of as a block. */
  .hint kbd {
    display: inline-block;
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

  /* ── Track boundary (virtual Start) ──────────────────────── */

  .boundary {
    border-style: dashed;
  }

  .boundary .chip-label,
  .boundary .label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-faint);
    letter-spacing: 0.02em;
  }

  /* Both .index and .boundary-index are single-class, and .index (with its
     accent background) is defined later — so qualify with .index to win the
     cascade and keep the boundary badge muted, matching the timeline pin. */
  .index.boundary-index {
    background: var(--text-faint);
  }

  /* ── Blocks view ─────────────────────────────────────────── */

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
    gap: 6px;
  }

  .chip {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 4px 8px;
    /* One step up the surface ramp from the enclosing .surface card (which is
       --bg-panel) so the tiles read as distinct from the card, not flush with
       it. */
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-align: left;
    user-select: none;
    touch-action: manipulation;
  }

  .chip-btn {
    cursor: pointer;
  }

  .chip-btn:hover {
    background: var(--bg-active);
  }

  .chip.ranged {
    border-color: var(--accent-ink);
    box-shadow: inset 0 0 0 1px var(--accent-ink);
  }

  .chip-head {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-width: 0;
  }

  .chip-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--text);
  }

  .chip-actions {
    display: flex;
    gap: 2px;
  }

  /* ── Shared bits ─────────────────────────────────────────── */

  .index {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }

  /* The play glyph sits centred over the number and fades in on hover,
     hinting that the badge plays from (and loops) the marker. */
  .index .play {
    position: absolute;
    inset: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
  }

  .index-btn:has(.play):hover .num,
  .chip-btn:has(.play):hover .num,
  .row-btn:has(.play):hover .num {
    opacity: 0;
  }

  .index-btn:hover .play,
  .chip-btn:hover .play,
  .row-btn:hover .play {
    opacity: 1;
  }

  .time {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
  }

  /* ── List view ───────────────────────────────────────────── */

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    /* One step up the surface ramp from the enclosing .surface card (which is
       --bg-panel) so the rows read as distinct from the card, not flush with
       it. */
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .row.ranged {
    border-color: var(--accent-ink);
    box-shadow: inset 0 0 0 1px var(--accent-ink);
  }

  .row-btn {
    width: 100%;
    text-align: left;
    cursor: pointer;
    user-select: none;
    touch-action: manipulation;
  }

  .row-btn:hover {
    background: var(--bg-active);
  }

  .label.faint {
    color: var(--text-faint);
  }

  /* A custom marker name renders in a monospace font so aligned text — chord
     charts, tab, etc. — lines up column by column. */
  .label.mono {
    font-family: var(--font-mono);
  }

  .index-btn {
    cursor: pointer;
    user-select: none;
    touch-action: manipulation;
  }

  /* Pointer-driven controls: the ranged border already signals state, so
     skip the theme's focus-visible ring here. */
  .chip-btn:focus-visible,
  .row-btn:focus-visible,
  .index-btn:focus-visible {
    outline: none;
  }

  .label {
    flex: 1;
    min-width: 0;
  }

  /* Matches what a marker row spends on its two actions: the shared 30px icon
     button twice, plus the row's own 8px gap between them. */
  .actions-spacer {
    flex: none;
    width: 68px;
    height: 30px;
  }
</style>
