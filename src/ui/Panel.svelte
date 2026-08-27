<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PanelId } from '@/core/model/types';
  import { PANEL_LABELS } from '@/core/model/defaults';
  import { uiPrefs } from '@/features/settings/panel/settings.svelte';
  import { cubicOut } from 'svelte/easing';
  import { slide } from 'svelte/transition';
  import Icon from './shared/Icon.svelte';
  import IconButton from './shared/IconButton.svelte';
  import Toggle from './shared/Toggle.svelte';
  import { tooltip } from './shared/tooltip.svelte';

  /** Kept short — the connection banner above carries the full explanation. */
  const UNAVAILABLE_HINT = 'This page blocks the audio processor — switch to tab capture';

  let {
    id,
    onreset,
    resettable = true,
    value,
    enabled,
    onenabledchange,
    header,
    actions,
    children,
    details,
    grouped = false,
    unavailable = false,
  }: {
    id: PanelId;
    onreset?: () => void;
    /** False while there is nothing to reset: the button stays mounted but
     * invisible, so it can't nudge the header on its way in and out. */
    resettable?: boolean;
    /** Compact value readout shown in the header (e.g. "0", "100%"). */
    value?: string;
    /** Effect bypass state; with `onenabledchange` adds a switch at the
     * header's right edge (after the chevron when one is present). */
    enabled?: boolean;
    onenabledchange?: (enabled: boolean) => void;
    /** Optional richer header content rendered after the title. */
    header?: Snippet;
    /** Right-aligned header controls, rendered just before the chevron —
     * always visible, even while the details are collapsed. */
    actions?: Snippet;
    /** Always-visible content below the header. */
    children?: Snippet;
    /** Collapsible content below `children`; its presence adds the chevron. */
    details?: Snippet;
    /** Drops the panel's own card surface; the container supplies one. */
    grouped?: boolean;
    /** The panel's effect can't reach the audio in this connection mode: dims
     * the card and inhibits its header controls. Panels that set this must also
     * disable their own inputs — this only owns the shared chrome. */
    unavailable?: boolean;
  } = $props();

  let collapsed = $derived(uiPrefs.current.collapsed[id]);
</script>

{#snippet title()}
  <span class="font-[650] text-[13.5px]">{PANEL_LABELS[id]}</span>
  {#if value !== undefined && enabled !== false}
    <span
      class="font-mono text-[11.5px] font-semibold text-accent-ink bg-accent-softer border border-accent-line px-1.75 py-px rounded-[6px] min-w-8.5 text-center tabular-nums"
      >{value}</span
    >
  {/if}
{/snippet}

<!-- `.panel` is kept as a hook: PanelStack draws seams between adjacent panels
     via `.group > :global(.panel + .panel)`. -->
<section
  class={['panel px-3.5 py-3', { surface: !grouped, unavailable }]}
  aria-label={PANEL_LABELS[id]}
  {@attach tooltip(unavailable ? UNAVAILABLE_HINT : '')}
>
  <header class="flex items-center gap-2 min-h-7">
    {#if details && enabled !== false}
      <button
        type="button"
        class="flex items-center gap-3 min-w-0 text-left py-0.5"
        aria-expanded={!collapsed}
        disabled={unavailable}
        onclick={() => uiPrefs.toggleCollapsed(id)}
      >
        {@render title()}
      </button>
    {:else}
      <span class="flex items-center gap-3 min-w-0">
        {@render title()}
      </span>
    {/if}
    {#if onreset && enabled !== false}
      <span class={['reset', { idle: !resettable }]}>
        <IconButton
          icon="reset"
          label="Reset {PANEL_LABELS[id]}"
          size={15}
          disabled={unavailable}
          onclick={onreset}
        />
      </span>
    {/if}
    {#if header && enabled !== false}
      {@render header()}
    {/if}
    <span class="flex items-center gap-1 ml-auto text-muted">
      {#if actions && enabled !== false}
        <span class="flex items-center mr-1">
          {@render actions()}
        </span>
      {/if}
      {#if details && enabled !== false}
        <button
          type="button"
          class={[
            'inline-flex items-center justify-center size-6.5 rounded-sm text-muted transition-transform duration-180 ease-out hover:bg-hover hover:text-fg',
            { 'rotate-180': !collapsed },
          ]}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          disabled={unavailable}
          onclick={() => uiPrefs.toggleCollapsed(id)}
        >
          <Icon name="chevronDown" size={16} />
        </button>
      {/if}
      {#if onenabledchange}
        <Toggle
          checked={enabled ?? false}
          label="Enable {PANEL_LABELS[id]}"
          disabled={unavailable}
          onchange={onenabledchange}
        />
      {/if}
    </span>
  </header>
  {#if children && enabled !== false}
    <div
      class="pt-2.5 transition-opacity duration-150"
      transition:slide={{ duration: 180, easing: cubicOut }}
    >
      {@render children()}
    </div>
  {/if}
  {#if details && !collapsed && enabled !== false}
    <div
      class="pt-2.5 transition-opacity duration-150"
      transition:slide={{ duration: 180, easing: cubicOut }}
    >
      {@render details()}
    </div>
  {/if}
</section>

<style>
  /* Cap the shared 30px icon button at the header's reserved height so the
     reset button coming and going never changes the panel height. */
  .reset :global(.icon-btn) {
    width: 26px;
    height: 26px;
  }

  /* Nothing to reset: keep the slot's width and hide the button in place —
     `visibility` also takes it out of the tab order and the a11y tree. */
  .reset.idle {
    visibility: hidden;
  }

  /* Inert in this connection mode. Dimmed as a whole rather than restyled, so
     the panel still reads as itself — the layout never moves when a page turns
     out to block the processor. Its controls carry their own :disabled look. */
  .panel.unavailable {
    opacity: 0.5;
    cursor: default;
    transition: opacity 0.15s;
  }
</style>
