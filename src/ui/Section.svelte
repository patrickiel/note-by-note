<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { SectionId } from '@/core/model/types';
  import { uiPrefs } from '@/features/settings/panel/settings.svelte';
  import { cubicOut } from 'svelte/easing';
  import { slide } from 'svelte/transition';
  import Icon from './shared/Icon.svelte';

  let {
    id,
    label,
    header,
    children,
  }: {
    id: SectionId;
    /** Uppercase row label; also the section's aria-label. */
    label: string;
    /** Controls rendered in the header row between the title and the chevron. */
    header?: Snippet;
    children: Snippet;
  } = $props();

  let collapsed = $derived(uiPrefs.current.collapsedSections[id]);
</script>

<!-- `relative min-w-0` on the head row: `relative` lets a section overlay
     content on the row (Looper's fine-tune hint), `min-w-0` lets long header
     controls shrink instead of overflowing. -->
<section class="flex flex-col gap-1.5" aria-label={label}>
  <div class="section-head group relative min-w-0">
    <button
      type="button"
      class="flex items-center min-w-0 text-left"
      aria-expanded={!collapsed}
      onclick={() => uiPrefs.toggleSectionCollapsed(id)}
    >
      <h2 class="section-title transition-colors duration-150 group-hover:text-fg">{label}</h2>
    </button>
    {@render header?.()}
    <!-- Redundant, non-focusable target so clicking the empty stretch of the
         row (not just the label or chevron) toggles too. Sits after any
         interactive header controls so it never covers them. -->
    <button
      type="button"
      class="flex-1 self-stretch"
      aria-hidden="true"
      tabindex="-1"
      onclick={() => uiPrefs.toggleSectionCollapsed(id)}
    ></button>
    <button
      type="button"
      class={[
        'inline-flex flex-none items-center justify-center size-5 rounded-sm text-muted transition-transform duration-180 ease-out hover:bg-hover hover:text-fg',
        { 'rotate-180': !collapsed },
      ]}
      aria-label={collapsed ? 'Expand' : 'Collapse'}
      onclick={() => uiPrefs.toggleSectionCollapsed(id)}
    >
      <Icon name="chevronDown" size={13} />
    </button>
  </div>
  {#if !collapsed}
    <div transition:slide={{ duration: 180, easing: cubicOut }}>
      {@render children()}
    </div>
  {/if}
</section>
