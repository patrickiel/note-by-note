<script lang="ts" generics="T extends string | number">
  let {
    options,
    value = $bindable(),
    label,
    disabled = false,
    onchange,
  }: {
    options: { value: T; label: string }[];
    value?: T;
    label: string;
    disabled?: boolean;
    onchange?: (value: T) => void;
  } = $props();

  function handle(event: Event) {
    const raw = (event.currentTarget as HTMLSelectElement).value;
    const match = options.find((o) => String(o.value) === raw);
    if (!match) return;
    value = match.value;
    onchange?.(match.value);
  }
</script>

<select aria-label={label} value={String(value)} {disabled} onchange={handle}>
  {#each options as option (option.value)}
    <option value={String(option.value)}>{option.label}</option>
  {/each}
</select>

<style>
  select {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--text);
    font-weight: 600;
    font-size: 13px;
    padding: 4px 18px 4px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23a8a8a8'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0 center;
    background-size: 16px;
  }

  select:hover:not(:disabled) {
    background-color: var(--bg-hover);
  }

  select:disabled {
    opacity: 0.4;
    cursor: default;
  }

  option {
    background: var(--bg-panel);
    color: var(--text);
  }
</style>
