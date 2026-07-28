<script lang="ts">
  let {
    value = $bindable(0),
    min,
    max,
    step = 1,
    defaultValue,
    fillFrom,
    disabled = false,
    label,
    onchange,
  }: {
    value?: number;
    min: number;
    max: number;
    step?: number;
    /** Value restored on double-click. Omit to disable double-click reset. */
    defaultValue?: number;
    /**
     * Value the amber fill band originates from. Defaults to `defaultValue`, so
     * the fill reads as a signed deviation from the reset point. Set to `min`
     * for magnitude sliders (e.g. volume) that should fill from the track start.
     */
    fillFrom?: number;
    disabled?: boolean;
    label: string;
    /** Fired on every input with the new value. */
    onchange?: (value: number) => void;
  } = $props();

  function set(next: number) {
    const clamped = Math.min(max, Math.max(min, next));
    // Snap to step grid to avoid float drift.
    const snapped = Math.round(clamped / step) * step;
    value = Number(snapped.toFixed(4));
    onchange?.(value);
  }

  function oninput(event: Event) {
    set(Number((event.currentTarget as HTMLInputElement).value));
  }

  function ondblclick() {
    if (disabled || defaultValue === undefined) return;
    set(defaultValue);
  }

  // The amber fill is a band from the fill origin to the thumb, so the slider
  // reads as a signed deviation from its default (centre-out for the bipolar
  // params, from 100% for speed). The origin is `fillFrom` when given, else the
  // default value, else the track start.
  const range = $derived(max > min ? max - min : 1);
  const pct = $derived(((value - min) / range) * 100);
  const origin = $derived(fillFrom ?? defaultValue);
  const basePct = $derived(
    origin !== undefined ? ((origin - min) / range) * 100 : 0,
  );
  const fillStart = $derived(Math.min(pct, basePct));
  const fillEnd = $derived(Math.max(pct, basePct));
</script>

<input
  type="range"
  {min}
  {max}
  {step}
  {value}
  {disabled}
  aria-label={label}
  style="--fill-start: {fillStart}%; --fill-end: {fillEnd}%"
  {oninput}
  {ondblclick}
/>

<style>
  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    flex: 1;
    width: 100%;
    height: 22px;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  /* Chrome marks range inputs :focus-visible even on mouse click, which would
     ring the whole slider; the accent thumb is indicator enough. */
  input[type='range']:focus {
    outline: none;
  }

  input[type='range']:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Amber band from the default position to the thumb, warm-neutral remainder. */
  input[type='range']::-webkit-slider-runnable-track {
    height: 5px;
    border-radius: 3px;
    background: linear-gradient(
      90deg,
      var(--track) var(--fill-start, 0%),
      var(--accent) var(--fill-start, 0%),
      var(--accent) var(--fill-end, 0%),
      var(--track) var(--fill-end, 0%)
    );
  }

  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 17px;
    height: 17px;
    margin-top: -6px;
    border-radius: 50%;
    background: var(--thumb);
    border: 2px solid var(--thumb-border);
    box-shadow: var(--thumb-shadow);
    transition: transform 0.12s;
  }

  input[type='range']:hover:not(:disabled)::-webkit-slider-thumb {
    transform: scale(1.12);
  }

  /* Firefox: the native progress fills from the left only, so paint the band on
     the track itself and hide the progress. */
  input[type='range']::-moz-range-track {
    height: 5px;
    border-radius: 3px;
    background: linear-gradient(
      90deg,
      var(--track) var(--fill-start, 0%),
      var(--accent) var(--fill-start, 0%),
      var(--accent) var(--fill-end, 0%),
      var(--track) var(--fill-end, 0%)
    );
  }

  input[type='range']::-moz-range-progress {
    background: transparent;
  }

  input[type='range']::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--thumb);
    border: 2px solid var(--thumb-border);
    box-shadow: var(--thumb-shadow);
  }
</style>
