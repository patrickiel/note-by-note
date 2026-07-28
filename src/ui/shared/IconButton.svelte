<script lang="ts">
  import type { IconName } from '@/ui/icons';
  import type { ActionId } from '@/core/model/types';
  import Icon from './Icon.svelte';
  import { tooltip } from './tooltip.svelte';

  let {
    icon,
    label,
    onclick,
    active = false,
    disabled = false,
    size = 18,
    danger = false,
    action,
  }: {
    icon: IconName;
    /** Accessible name + tooltip. */
    label: string;
    onclick?: (event: MouseEvent) => void;
    active?: boolean;
    disabled?: boolean;
    size?: number;
    danger?: boolean;
    /** Shortcut this button duplicates; its binding shows in the tooltip. */
    action?: ActionId;
  } = $props();
</script>

<!-- `.icon-btn` is kept as a hook: Panel caps it to 26px and HeaderBar tints the
     power button via :global. Colors are picked per-state so no two utilities
     fight over the same property (hover always wins, matching the old CSS). -->
<button
  type="button"
  class={[
    'icon-btn inline-flex items-center justify-center size-7.5 rounded-sm transition-colors duration-120',
    'hover:not-disabled:bg-hover disabled:opacity-35 disabled:cursor-default',
    active ? 'text-accent-ink bg-accent-soft' : 'text-muted',
    danger ? 'hover:not-disabled:text-danger' : 'hover:not-disabled:text-fg',
  ]}
  aria-label={label}
  aria-pressed={active ? 'true' : undefined}
  {disabled}
  {onclick}
  {@attach tooltip(label, { action })}
>
  <Icon name={icon} {size} />
</button>
