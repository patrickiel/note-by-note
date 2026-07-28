<script lang="ts">
  import { tooltip } from './tooltip.svelte';

  let {
    value,
    placeholder = '',
    mono = false,
    label,
    readonly = false,
    oncommit,
  }: {
    value: string;
    placeholder?: string;
    mono?: boolean;
    label: string;
    readonly?: boolean;
    /** Called with the new text; return false to reject and revert. */
    oncommit: (text: string) => boolean | void;
  } = $props();

  let editing = $state(false);
  let draft = $state('');

  function begin() {
    draft = value;
    editing = true;
  }

  function commit() {
    if (!editing) return;
    editing = false;
    if (draft === value) return;
    if (oncommit(draft) === false) draft = value;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') editing = false;
    event.stopPropagation();
  }

  function focusInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
</script>

{#if editing}
  <input
    class={['edit', { mono }]}
    bind:value={draft}
    aria-label={label}
    onblur={commit}
    {onkeydown}
    {@attach focusInput}
  />
{:else if readonly}
  <span class={['text', 'readonly', { mono, empty: !value }]}>
    {value || placeholder}
  </span>
{:else}
  <button
    type="button"
    class={['text', { mono, empty: !value }]}
    onclick={begin}
    {@attach tooltip(label)}
  >
    {value || placeholder}
  </button>
{/if}

<style>
  .text {
    color: inherit;
    font-size: inherit;
    font-weight: inherit;
    padding: 1px 3px;
    margin: -1px -3px;
    border-radius: 4px;
    text-align: left;
  }

  .text:not(.readonly):hover {
    background: var(--bg-hover);
  }

  .text.empty {
    color: var(--text-faint);
    font-style: italic;
  }

  .edit {
    font-size: inherit;
    font-weight: inherit;
    color: var(--text);
    background: var(--bg-inset);
    border: 1px solid var(--accent-ink);
    border-radius: 4px;
    padding: 0 3px;
    margin: -1px -4px;
    width: 100%;
    min-width: 40px;
    outline: none;
  }

  .mono {
    font-family: var(--font-mono);
  }
</style>
