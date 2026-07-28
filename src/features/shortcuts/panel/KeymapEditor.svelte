<script lang="ts">
  import { ACTION_LABELS, DEFAULT_KEYMAP } from '@/core/model/defaults';
  import type { ActionId } from '@/core/model/types';
  import { comboChips } from '@/ui/shared/hotkey';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { settings } from '@/features/settings/panel/settings.svelte';

  let { enabled = false }: { enabled?: boolean } = $props();

  const actions = Object.keys(ACTION_LABELS) as ActionId[];

  /** Action currently waiting for a key press, if any. */
  let capturing = $state<ActionId | null>(null);

  /** Custom map when editing is enabled, read-only defaults otherwise. */
  const keymap = $derived(enabled ? settings.current.keymap : DEFAULT_KEYMAP);

  /** Combos assigned to more than one action. */
  const conflicts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const action of actions) {
      const combo = keymap[action];
      counts.set(combo, (counts.get(combo) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [combo, n] of Array.from(counts)) {
      if (n > 1) dupes.add(combo);
    }
    return dupes;
  });

  function beginCapture(action: ActionId) {
    if (!enabled) return;
    capturing = capturing === action ? null : action;
  }

  function onkeydown(event: KeyboardEvent) {
    if (capturing === null) return;
    if (!enabled) {
      capturing = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      capturing = null;
      return;
    }
    // Ignore bare modifier presses; wait for a real key.
    if (
      event.key === 'Shift' ||
      event.key === 'Control' ||
      event.key === 'Alt' ||
      event.key === 'Meta'
    ) {
      return;
    }
    let combo = '';
    if (event.shiftKey) combo += 'Shift+';
    if (event.ctrlKey) combo += 'Ctrl+';
    if (event.altKey) combo += 'Alt+';
    combo +=
      event.key === ' '
        ? 'Space'
        : event.key.length === 1
          ? event.key.toLowerCase()
          : event.key;
    void settings.update({
      keymap: { ...settings.current.keymap, [capturing]: combo },
    });
    capturing = null;
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

<div class="keymap">
  <ul>
    {#each actions as action (action)}
      <li>
        <span class="label">{ACTION_LABELS[action]}</span>
        <button
          type="button"
          class={[
            'binding',
            {
              capturing: capturing === action,
              conflict: conflicts.has(keymap[action]) && capturing !== action,
            },
          ]}
          disabled={!enabled}
          aria-label={`Shortcut for ${ACTION_LABELS[action]}: ${keymap[action]}`}
          onclick={() => beginCapture(action)}
          {@attach tooltip(
            enabled
              ? `Change shortcut for ${ACTION_LABELS[action]}`
              : 'Enable custom shortcuts to edit',
          )}
        >
          {#if capturing === action}
            <kbd class="wide">Press a key…</kbd>
          {:else}
            {#each comboChips(keymap[action]) as chip, i (i)}
              <kbd>{chip}</kbd>
            {/each}
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if enabled && conflicts.size > 0}
    <p class="conflict-note">Some shortcuts share the same key.</p>
  {/if}
</div>

<style>
  .keymap {
    width: 100%;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
  }

  .label {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* A combo renders as one chip per key (⇧ ←). The fixed min-width keeps the
     column steady whether a row holds one chip, two, or the capture prompt. */
  .binding {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
    min-width: 96px;
    border-radius: var(--radius-sm);
  }

  .binding:disabled {
    cursor: default;
  }

  kbd {
    display: block;
    min-width: 26px;
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.2;
    text-align: center;
    color: var(--text);
    background: var(--bg-inset);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }

  .binding:hover:not(:disabled) kbd {
    border-color: var(--accent-ink);
  }

  .binding.capturing kbd {
    color: var(--accent-ink);
    border-color: var(--accent-ink);
  }

  .binding.conflict kbd {
    color: var(--danger);
    border-color: var(--danger);
  }

  .conflict-note {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--danger);
  }
</style>
