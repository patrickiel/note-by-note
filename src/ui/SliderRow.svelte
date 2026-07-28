<script lang="ts">
  import type { ActionId } from '@/core/model/types';
  import Slider from './shared/Slider.svelte';
  import Stepper from './shared/Stepper.svelte';

  let {
    value = $bindable(0),
    min,
    max,
    step = 1,
    stepButton = step,
    defaultValue,
    disabled = false,
    label,
    downAction,
    upAction,
    onchange,
  }: {
    value?: number;
    min: number;
    max: number;
    step?: number;
    /** Increment used by the −/+ buttons when it differs from the slider step. */
    stepButton?: number;
    /** Value restored on double-click. Omit to disable double-click reset. */
    defaultValue?: number;
    disabled?: boolean;
    label: string;
    /** Shortcuts the −/+ buttons duplicate; shown in their tooltips. */
    downAction?: ActionId;
    upAction?: ActionId;
    onchange?: (value: number) => void;
  } = $props();

  function nudge(direction: -1 | 1) {
    const next = Math.min(max, Math.max(min, value + direction * stepButton));
    value = Number(next.toFixed(4));
    onchange?.(value);
  }
</script>

<div class="flex items-center gap-1.5">
  <Stepper
    direction={-1}
    label="Decrease {label}"
    action={downAction}
    {disabled}
    onstep={() => nudge(-1)}
  />
  <Slider bind:value {min} {max} {step} {defaultValue} {disabled} {label} {onchange} />
  <Stepper
    direction={1}
    label="Increase {label}"
    action={upAction}
    {disabled}
    onstep={() => nudge(1)}
  />
</div>
