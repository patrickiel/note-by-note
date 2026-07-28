<script lang="ts">
  import type { ActionId } from '@/core/model/types';
  import Icon from './Icon.svelte';
  import { tooltip } from './tooltip.svelte';

  let {
    direction,
    onstep,
    disabled = false,
    label,
    action,
  }: {
    direction: -1 | 1;
    onstep: () => void;
    disabled?: boolean;
    label: string;
    /** Shortcut this step duplicates; its binding shows in the tooltip. */
    action?: ActionId;
  } = $props();

  let repeatTimer: ReturnType<typeof setTimeout> | undefined;

  // Hold to repeat, like hardware steppers.
  function press() {
    onstep();
    repeatTimer = setTimeout(function tick() {
      onstep();
      repeatTimer = setTimeout(tick, 80);
    }, 450);
  }

  function release() {
    clearTimeout(repeatTimer);
  }
</script>

<button
  type="button"
  class="inline-flex items-center justify-center size-6.5 flex-none rounded-sm text-muted ghost"
  aria-label={label}
  {disabled}
  {@attach tooltip(label, { action })}
  onpointerdown={press}
  onpointerup={release}
  onpointerleave={release}
  onpointercancel={release}
>
  <Icon name={direction > 0 ? 'plus' : 'minus'} size={16} />
</button>
