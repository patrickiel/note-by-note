<script lang="ts" generics="T extends string">
  import type { IconName } from '@/ui/icons';
  import Icon from './Icon.svelte';
  import { tooltip } from './tooltip.svelte';

  let {
    options,
    value = $bindable(),
    onchange,
  }: {
    options: { value: T; label: string; icon?: IconName }[];
    value?: T;
    onchange?: (value: T) => void;
  } = $props();

  function select(next: T) {
    value = next;
    onchange?.(next);
  }
</script>

<!-- `.segmented` / `.segment` are kept as hooks: HeaderBar's hue popover reaches
     them via :global to stretch the control across its width. -->
<div class="segmented inline-flex gap-0.5 p-0.5 rounded-full bg-inset" role="radiogroup">
  {#each options as option (option.value)}
    <button
      type="button"
      class={[
        'segment inline-flex items-center justify-center min-w-8.5 h-6 px-2.5 rounded-full text-xs font-semibold',
        option.value === value
          ? 'bg-accent text-accent-contrast'
          : 'text-muted hover:text-fg',
      ]}
      role="radio"
      aria-checked={option.value === value}
      aria-label={option.icon ? option.label : undefined}
      onclick={() => select(option.value)}
      {@attach tooltip(option.icon ? option.label : '')}
    >
      {#if option.icon}
        <Icon name={option.icon} size={15} />
      {:else}
        {option.label}
      {/if}
    </button>
  {/each}
</div>
