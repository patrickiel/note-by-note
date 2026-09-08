<script lang="ts">
  import Icon from '@/ui/shared/Icon.svelte';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import SegmentedControl from '@/ui/shared/SegmentedControl.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { formatSpeedPct, formatTranspose } from '@/core/model/format';
  import { cleanTitle } from '@/core/model/track-identity';
  import { youtubeThumbnailUrl } from '@/core/model/thumbnail';
  import type { FavoriteEntry, FavoritesSort, HistoryEntry } from '@/core/model/types';
  import { favorites } from '@/features/library/panel/favorites.svelte';
  import { history } from '@/features/library/panel/history.svelte';
  import { uiPrefs } from '@/features/settings/panel/settings.svelte';
  import { view } from '@/core/state/view.svelte';

  let {
    onopen,
  }: {
    onopen?: (entry: HistoryEntry) => void;
  } = $props();

  const tab = $derived(uiPrefs.current.libraryTab);

  const SORT_OPTIONS: { value: FavoritesSort; label: string }[] = [
    { value: 'lastAccessed', label: 'Last Accessed' },
    { value: 'title', label: 'A–Z' },
    { value: 'manual', label: 'Manual' },
  ];

  const sort = $derived(uiPrefs.current.favoritesSort);

  const sortedFavorites = $derived.by((): FavoriteEntry[] => {
    const list = favorites.entries;
    switch (sort) {
      case 'lastAccessed':
        return [...list].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
      case 'title':
        return [...list].sort((a, b) =>
          cleanTitle(a.identity.title).localeCompare(cleanTitle(b.identity.title), undefined, {
            sensitivity: 'base',
          }),
        );
      case 'manual':
        return list;
    }
  });

  function relativeTime(timestamp: number): string {
    const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = seconds / 60;
    if (minutes < 60) return `${Math.floor(minutes)} min ago`;
    const hours = minutes / 60;
    if (hours < 24) return `${Math.floor(hours)} h ago`;
    const days = hours / 24;
    if (days < 30) return `${Math.floor(days)} d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  /** Non-default settings summarized as compact chips (e.g. "↑+2", "S 80%"). */
  function summaryChips(entry: HistoryEntry): string[] {
    const chips: string[] = [];
    const p = entry.params;
    // `!== false` keeps entries saved before the bypass switches existed.
    if (p.transposeEnabled !== false && p.transpose !== 0)
      chips.push(`↑${formatTranspose(p.transpose)}`);
    if (p.speedEnabled !== false && p.speed !== 1) chips.push(`S ${formatSpeedPct(p.speed)}`);
    if (p.pitchEnabled !== false && p.pitchCents !== 0)
      chips.push(`${p.pitchCents > 0 ? '+' : ''}${p.pitchCents}c`);
    if (p.vocalReduceEnabled !== false && p.vocalReduce > 0)
      chips.push(`${p.vocalMode === 'isolate' ? 'Iso' : 'V'} ${Math.round(p.vocalReduce * 100)}%`);
    return chips;
  }

  /** Entries saved before thumbnail capture existed still get YouTube artwork. */
  function thumbnail(entry: HistoryEntry): string | undefined {
    return entry.thumbnailUrl ?? youtubeThumbnailUrl(entry.pageUrl);
  }

  // --- Manual drag & drop reordering (Favorites → Manual sort) -------------
  // Pointer-based: the grabbed row follows the pointer, siblings shift by one
  // row height with a transition, and the new order is committed on release.

  /** Vertical gap between rows — keep in sync with the .list `gap` style. */
  const LIST_GAP = 2;

  let drag = $state<{
    key: string;
    index: number;
    targetIndex: number;
    startY: number;
    dy: number;
    /** Row height + list gap: pointer distance that equals one position. */
    rowStep: number;
  } | null>(null);

  function startDrag(event: PointerEvent, key: string, index: number) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const row = handle.closest('.row');
    if (!(row instanceof HTMLElement)) return;
    handle.setPointerCapture(event.pointerId);
    drag = {
      key,
      index,
      targetIndex: index,
      startY: event.clientY,
      dy: 0,
      rowStep: row.offsetHeight + LIST_GAP,
    };
  }

  function moveDrag(event: PointerEvent) {
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    const targetIndex = Math.min(
      sortedFavorites.length - 1,
      Math.max(0, drag.index + Math.round(dy / drag.rowStep)),
    );
    drag = { ...drag, dy, targetIndex };
  }

  function endDrag() {
    if (!drag) return;
    const { index, targetIndex } = drag;
    drag = null;
    if (index === targetIndex) return;
    const keys = sortedFavorites.map((e) => e.identity.key);
    const [moved] = keys.splice(index, 1);
    keys.splice(targetIndex, 0, moved);
    void favorites.reorder(keys);
  }

  function cancelDrag() {
    drag = null;
  }

  /** Where a row currently sits relative to its layout position, in px. */
  function rowShift(index: number): number {
    if (!drag) return 0;
    if (index === drag.index) return drag.dy;
    if (drag.targetIndex > drag.index && index > drag.index && index <= drag.targetIndex) {
      return -drag.rowStep;
    }
    if (drag.targetIndex < drag.index && index < drag.index && index >= drag.targetIndex) {
      return drag.rowStep;
    }
    return 0;
  }

  /** Keyboard alternative to dragging: arrow keys move the focused row. */
  function nudge(event: KeyboardEvent, index: number) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const targetIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= sortedFavorites.length) return;
    const keys = sortedFavorites.map((e) => e.identity.key);
    [keys[index], keys[targetIndex]] = [keys[targetIndex], keys[index]];
    void favorites.reorder(keys);
  }
</script>

{#snippet entryButton(entry: HistoryEntry, time: number)}
  <button
    type="button"
    class="flex items-center gap-2.5 flex-1 min-w-0 p-2 rounded-sm text-left hover:bg-hover"
    onclick={() => onopen?.(entry)}
    {@attach tooltip(cleanTitle(entry.identity.title))}
  >
    <span
      class="flex items-center justify-center flex-none w-17 h-9.5 rounded-sm bg-hover text-muted overflow-hidden"
    >
      {#if thumbnail(entry)}
        <img src={thumbnail(entry)} alt="" loading="lazy" class="w-full h-full object-cover" />
      {:else}
        <Icon name="file" size={26} />
      {/if}
    </span>
    <span class="flex flex-col min-w-0 gap-0.5">
      <span class="font-semibold truncate">{cleanTitle(entry.identity.title) || entry.pageUrl}</span>
      <span class="flex items-center gap-1.5 text-[11.5px] text-muted">
        <span>{relativeTime(time)}</span>
        {#each summaryChips(entry) as chip (chip)}
          <span
            class="bg-accent-soft text-accent-ink rounded-full px-1.5 font-semibold text-[10.5px] whitespace-nowrap"
            >{chip}</span
          >
        {/each}
      </span>
    </span>
  </button>
{/snippet}

<div class="absolute inset-0 z-50 flex flex-col bg-base overflow-hidden" role="dialog" aria-label="Songs">
  <header class="flex-none flex items-center px-3 py-2.5 bg-base">
    <h1 class="flex-1 m-0 text-[15px] font-bold text-center pl-7.5">Songs</h1>
    <IconButton icon="close" label="Close songs" onclick={() => view.close()} />
  </header>

  <div class="flex flex-none gap-1 px-3 pb-2 border-b border-line" role="tablist">
    <button
      type="button"
      role="tab"
      class={[
        'px-3.5 py-1.5 rounded-full font-semibold',
        tab === 'recent' ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:text-fg',
      ]}
      aria-selected={tab === 'recent'}
      onclick={() => uiPrefs.setLibraryTab('recent')}
    >
      Recent
    </button>
    <button
      type="button"
      role="tab"
      class={[
        'px-3.5 py-1.5 rounded-full font-semibold',
        tab === 'favorites' ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:text-fg',
      ]}
      aria-selected={tab === 'favorites'}
      onclick={() => uiPrefs.setLibraryTab('favorites')}
    >
      Favorites
    </button>
  </div>

  {#if tab === 'recent'}
    {#if history.entries.length === 0}
      <div class="flex flex-col items-center gap-2.5 px-6 py-12 text-faint text-center">
        <Icon name="history" size={28} />
        <p class="m-0 text-[12.5px]">Songs you adjust are saved here automatically.</p>
      </div>
    {:else}
      <div class="flex-1 min-h-0 overflow-y-auto">
        <div class="list flex flex-col p-2 gap-0.5">
          {#each history.entries as entry (entry.identity.key)}
            {@const favorited = favorites.has(entry.identity)}
            <div class="row relative flex items-center gap-0.5">
              {@render entryButton(entry, entry.updatedAt)}
              <IconButton
                icon={favorited ? 'star' : 'starOutline'}
                label={favorited ? 'Remove from Favorites' : 'Add to Favorites'}
                active={favorited}
                size={15}
                onclick={() => favorites.toggle(entry)}
              />
              <IconButton
                icon="trash"
                label="Remove from history"
                danger
                size={15}
                onclick={() => history.remove(entry.identity.key)}
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {:else if favorites.entries.length === 0}
    <div class="flex flex-col items-center gap-2.5 px-6 py-12 text-faint text-center">
      <Icon name="starOutline" size={28} />
      <p class="m-0 text-[12.5px]">No favorites yet. Star a song under Recent to keep it here.</p>
    </div>
  {:else}
    <div class="flex flex-none items-center gap-2 px-3 pt-2.5 pb-0.5">
      <span class="text-[11.5px] font-semibold text-muted">Sort by</span>
      <SegmentedControl
        options={SORT_OPTIONS}
        value={sort}
        onchange={(next) => uiPrefs.setFavoritesSort(next)}
      />
    </div>
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class={['list flex flex-col p-2 gap-0.5', { reordering: drag !== null }]}>
        {#each sortedFavorites as entry, index (entry.identity.key)}
          <div
            class={['row relative flex items-center gap-0.5', { dragging: drag?.key === entry.identity.key }]}
            style:transform={`translateY(${rowShift(index)}px)`}
          >
            {#if sort === 'manual'}
              <button
                type="button"
                class="drag-handle inline-flex items-center justify-center flex-none w-5.5 h-7.5 rounded-sm text-faint cursor-grab touch-none hover:text-fg hover:bg-hover"
                aria-label="Reorder (drag, or press the arrow keys)"
                {@attach tooltip('Drag to reorder, or use the arrow keys')}
                onpointerdown={(e) => startDrag(e, entry.identity.key, index)}
                onpointermove={moveDrag}
                onpointerup={endDrag}
                onpointercancel={cancelDrag}
                onkeydown={(e) => nudge(e, index)}
              >
                <Icon name="dragHandle" size={16} />
              </button>
            {/if}
            {@render entryButton(entry, entry.lastAccessedAt)}
            <IconButton
              icon="star"
              label="Remove from Favorites"
              active
              size={15}
              onclick={() => favorites.remove(entry.identity.key)}
            />
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Rows only animate while a drag is in progress — releasing commits the new
   * order instantly, so transforms must reset without a transition. */
  .list.reordering {
    user-select: none;
  }

  .list.reordering .row {
    transition: transform 0.15s ease;
  }

  .list.reordering .row.dragging {
    transition: none;
    z-index: 2;
    background: var(--bg);
    border-radius: var(--radius-sm);
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
  }

  .row.dragging .drag-handle {
    cursor: grabbing;
  }
</style>
