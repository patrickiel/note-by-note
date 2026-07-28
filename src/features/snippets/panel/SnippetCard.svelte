<script lang="ts">
  import EditableText from '@/ui/shared/EditableText.svelte';
  import Icon from '@/ui/shared/Icon.svelte';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import Slider from '@/ui/shared/Slider.svelte';
  import Toggle from '@/ui/shared/Toggle.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import {
    SPEED_MAX,
    SPEED_MIN,
    TRANSPOSE_RANGE_EXTENDED,
    TRANSPOSE_RANGE_STANDARD,
  } from '@/core/model/defaults';
  import {
    formatPrecise,
    formatSpeedPct,
    formatTranspose,
    parseTime,
  } from '@/core/model/format';
  import type { Snippet, SnippetOverrides } from '@/core/model/types';
  import { snippets } from '@/features/snippets/panel/snippets.svelte';
  import { settings } from '@/features/settings/panel/settings.svelte';
  import { session } from '@/core/state/session.svelte';

  let {
    snippet,
    index,
    onreorderstart,
  }: {
    snippet: Snippet;
    /** 1-based display position ("1. Pre"). */
    index: number;
    /** Pointer-down on the drag handle; the list owns the reorder gesture. */
    onreorderstart?: (event: PointerEvent) => void;
  } = $props();

  type ParamKey = keyof SnippetOverrides;

  const PARAM_KEYS: ParamKey[] = ['speed', 'transpose', 'vocalReduce'];

  let transposeLimit = $derived(
    settings.current.extendedTranspose ? TRANSPOSE_RANGE_EXTENDED : TRANSPOSE_RANGE_STANDARD,
  );

  let PARAM_META = $derived<
    Record<ParamKey, { label: string; min: number; max: number; step: number; init: number }>
  >({
    speed: { label: 'Speed', min: SPEED_MIN, max: SPEED_MAX, step: 0.05, init: 1.0 },
    transpose: {
      label: 'Transpose',
      min: -transposeLimit,
      max: transposeLimit,
      step: 1,
      init: 0,
    },
    vocalReduce: { label: 'Vocal Reducer', min: 0, max: 1, step: 0.05, init: 0.5 },
  });

  const REPEAT_CYCLE = [1, 2, 3, 4, 6, 8, Infinity];
  const REPEAT_VALUES = REPEAT_CYCLE.filter((value) => value !== 1);

  const formatRepeats = (value: number) => (Number.isFinite(value) ? String(value) : '∞');

  type Popover =
    | { kind: 'editor'; key: ParamKey }
    | { kind: 'add' }
    | { kind: 'more' }
    | { kind: 'repeat' };
  let popover = $state<Popover | null>(null);

  let setKeys = $derived(PARAM_KEYS.filter((key) => snippet.overrides[key] !== undefined));
  let unsetKeys = $derived(PARAM_KEYS.filter((key) => snippet.overrides[key] === undefined));

  let isActive = $derived(session.seq.running && session.seq.activeSnippetId === snippet.id);
  let countdownS = $derived(
    session.seq.activeSnippetId === snippet.id && session.countIn != null
      ? session.countIn.beats - session.countIn.beat + 1
      : null,
  );

  function formatValue(key: ParamKey, value: number): string {
    switch (key) {
      case 'speed':
        return formatSpeedPct(value);
      case 'transpose':
        return formatTranspose(value);
      case 'vocalReduce':
        return `${Math.round(value * 100)}%`;
    }
  }

  function chipText(key: ParamKey): string {
    const value = snippet.overrides[key];
    if (value === undefined) return '';
    switch (key) {
      case 'speed':
        return `S ${formatSpeedPct(value)}`;
      case 'transpose':
        return value < 0 ? `↓ −${Math.abs(value)}` : `↑ ${formatTranspose(value)}`;
      case 'vocalReduce':
        return `V ${Math.round(value * 100)}%`;
    }
  }

  function setOverride(key: ParamKey, value: number) {
    snippets.update(snippet.id, { overrides: { ...snippet.overrides, [key]: value } });
  }

  function addOverride(key: ParamKey) {
    setOverride(key, PARAM_META[key].init);
    popover = { kind: 'editor', key };
  }

  function removeOverride(key: ParamKey) {
    const overrides: SnippetOverrides = { ...snippet.overrides };
    delete overrides[key];
    snippets.update(snippet.id, { overrides });
    popover = null;
  }

  function commitName(text: string): boolean {
    const name = text.trim();
    if (!name) return false;
    snippets.update(snippet.id, { name });
    return true;
  }

  function commitStart(text: string): boolean {
    const t = parseTime(text);
    if (t === null || t >= snippet.endT) return false;
    snippets.update(snippet.id, { startT: t });
    return true;
  }

  function commitEnd(text: string): boolean {
    const t = parseTime(text);
    if (t === null || t <= snippet.startT) return false;
    snippets.update(snippet.id, { endT: t });
    return true;
  }

  function setRepeats(value: number) {
    snippets.update(snippet.id, { repeats: value });
  }

  function addRepeat() {
    snippets.update(snippet.id, { repeats: 2 });
    popover = { kind: 'repeat' };
  }

  function removeRepeat() {
    snippets.update(snippet.id, { repeats: 1 });
    popover = null;
  }

  /** Closes the popover on outside pointerdown or Escape. Attached to the
   * popover element; its wrapper (anchor included) counts as inside so the
   * anchor's own click keeps toggle semantics. */
  function dismiss(node: HTMLElement) {
    const scope = node.parentElement ?? node;
    const onPointerDown = (event: Event) => {
      if (!scope.contains(event.target as Node)) popover = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') popover = null;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }
</script>

<article
  class={['card', 'surface', { active: isActive }]}
  aria-label="Snippet {index}: {snippet.name}"
>
  <!-- Row 1: number, name, enable toggle, drag handle -->
  <div class="row head">
    <span class="num">{index}.</span>
    <span class="name">
      <EditableText value={snippet.name} label="Rename snippet" oncommit={commitName} />
    </span>
    <span class="head-actions">
      <Toggle
        checked={snippet.enabled}
        size="sm"
        label="Include snippet in sequence"
        onchange={(enabled) => snippets.update(snippet.id, { enabled })}
      />
      <button
        type="button"
        class="handle"
        aria-label="Drag to reorder"
        onpointerdown={onreorderstart}
        {@attach tooltip('Drag to reorder')}
      >
        <Icon name="dragHandle" size={16} />
      </button>
    </span>
  </div>

  <!-- Row 2: time range -->
  <div class="row times">
    <EditableText mono value={formatPrecise(snippet.startT)} label="Snippet start time" oncommit={commitStart} />
    <span class="sep"><Icon name="chevronRight" size={14} /></span>
    <EditableText mono value={formatPrecise(snippet.endT)} label="Snippet end time" oncommit={commitEnd} />
  </div>

  <!-- Footer: play/pause, parameter chips, add parameter, more -->
  <div class="row footer">
    <button
      type="button"
      class="play"
      aria-label={isActive ? 'Pause sequence' : 'Play from this snippet'}
      onclick={() => (isActive ? snippets.stop() : snippets.play(snippet.id))}
      {@attach tooltip(isActive ? 'Pause sequence' : 'Play from this snippet')}
    >
      <Icon name={isActive ? 'pause' : 'play'} size={15} />
      {#if isActive}
        <span class="lap" aria-label="Lap {session.seq.lap} of {formatRepeats(session.seq.totalLaps)}">
          {session.seq.lap}/{formatRepeats(session.seq.totalLaps)}
        </span>
      {/if}
    </button>
    {#if countdownS !== null}
      <span class="countdown" role="status" aria-label="Count-in: {countdownS}">{countdownS}</span>
    {/if}
    <div class="chips">
      {#each setKeys as key (key)}
        <span class="pop-wrap">
        <button
          type="button"
          class="chip"
          aria-label="{PARAM_META[key].label} override: {chipText(key)}"
          aria-expanded={popover?.kind === 'editor' && popover.key === key}
          {@attach tooltip(`Edit ${PARAM_META[key].label} override`)}
          onclick={() =>
            (popover =
              popover?.kind === 'editor' && popover.key === key
                ? null
                : { kind: 'editor', key })}
        >
          {chipText(key)}
        </button>
        {#if popover?.kind === 'editor' && popover.key === key}
          <div
            class="popover editor"
            role="dialog"
            aria-label="{PARAM_META[key].label} override"
            {@attach dismiss}
          >
            <div class="editor-head">
              <span class="editor-label">{PARAM_META[key].label}</span>
              <span class="editor-value">
                {formatValue(key, snippet.overrides[key] ?? PARAM_META[key].init)}
              </span>
              <IconButton
                icon="trash"
                size={14}
                danger
                label="Remove {PARAM_META[key].label} override"
                onclick={() => removeOverride(key)}
              />
            </div>
            <Slider
              value={snippet.overrides[key] ?? PARAM_META[key].init}
              min={PARAM_META[key].min}
              max={PARAM_META[key].max}
              step={PARAM_META[key].step}
              defaultValue={PARAM_META[key].init}
              label="{PARAM_META[key].label} override"
              onchange={(value) => setOverride(key, value)}
            />
          </div>
        {/if}
      </span>
    {/each}
    {#if snippet.repeats > 1}
      <span class="pop-wrap">
        <button
          type="button"
          class="chip"
          aria-label="Repeat override: ×{formatRepeats(snippet.repeats)}"
          aria-expanded={popover?.kind === 'repeat'}
          {@attach tooltip('Edit Repeat override')}
          onclick={() => (popover = popover?.kind === 'repeat' ? null : { kind: 'repeat' })}
        >
          ↻ ×{formatRepeats(snippet.repeats)}
        </button>
        {#if popover?.kind === 'repeat'}
          <div class="popover editor" role="dialog" aria-label="Repeat override" {@attach dismiss}>
            <div class="editor-head">
              <span class="editor-label">Repeat</span>
              <span class="editor-value">×{formatRepeats(snippet.repeats)}</span>
              <IconButton
                icon="trash"
                size={14}
                danger
                label="Remove Repeat override"
                onclick={removeRepeat}
              />
            </div>
            <div class="value-strip" role="group" aria-label="Repeat count">
              {#each REPEAT_VALUES as value (value)}
                <button
                  type="button"
                  aria-pressed={snippet.repeats === value}
                  class={['flyout-item', { sel: snippet.repeats === value }]}
                  onclick={() => setRepeats(value)}
                >
                  {formatRepeats(value)}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </span>
    {/if}
    </div>
    {#if unsetKeys.length > 0 || snippet.repeats === 1}
      <span class="pop-wrap">
        <button
          type="button"
          class="add-param"
          aria-label="Add parameter"
          aria-expanded={popover?.kind === 'add'}
          {@attach tooltip('Add parameter')}
          onclick={() => (popover = popover?.kind === 'add' ? null : { kind: 'add' })}
        >
          <Icon name="plus" size={16} />
        </button>
        {#if popover?.kind === 'add'}
          <div class="popover menu" role="menu" aria-label="Add parameter" {@attach dismiss}>
            {#each unsetKeys as key (key)}
              <button type="button" role="menuitem" class="menu-item" onclick={() => addOverride(key)}>
                {PARAM_META[key].label}
              </button>
            {/each}
            {#if snippet.repeats === 1}
              <button type="button" role="menuitem" class="menu-item" onclick={addRepeat}>
                Repeat
              </button>
            {/if}
          </div>
        {/if}
      </span>
    {/if}
    <span class="spacer"></span>
    <span class="pop-wrap">
      <IconButton
        icon="moreVert"
        label="More actions"
        active={popover?.kind === 'more'}
        onclick={() => (popover = popover?.kind === 'more' ? null : { kind: 'more' })}
      />
      {#if popover?.kind === 'more'}
        <div class="popover menu right" role="menu" aria-label="Snippet actions" {@attach dismiss}>
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            onclick={() => {
              snippets.duplicate(snippet.id);
              popover = null;
            }}
          >
            <Icon name="duplicate" size={14} />
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            class="menu-item danger"
            onclick={() => {
              snippets.remove(snippet.id);
              popover = null;
            }}
          >
            <Icon name="trash" size={14} />
            Delete
          </button>
        </div>
      {/if}
    </span>
  </div>
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 11px 12px;
  }

  .card.active {
    border-color: var(--accent-ink);
    /* Inset ring thickens the accent edge to match the selected marker tile
       (1px border + 1px inset), plus the soft glow. */
    box-shadow:
      inset 0 0 0 1px var(--accent-ink),
      0 0 10px var(--accent-soft);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* ── Row 1 ───────────────────────────────────────────────── */

  .num,
  .name {
    font-weight: 700;
  }

  .num {
    flex: none;
    color: var(--text-muted);
  }

  .name {
    flex: 1;
    min-width: 0;
  }

  .head-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: grab;
    touch-action: none;
  }

  .handle:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .handle:active {
    cursor: grabbing;
  }

  /* ── Row 2 ───────────────────────────────────────────────── */

  .times {
    font-size: 12px;
    padding-left: 2px;
  }

  .sep {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
  }

  /* ── Row 3: chips ────────────────────────────────────────── */

  .chips {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .pop-wrap {
    position: relative;
    display: inline-flex;
  }

  .chip {
    background: var(--accent-softer);
    color: var(--accent-ink);
    border: 1px solid var(--accent-line);
    border-radius: 7px;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
  }

  .chip:hover {
    background: var(--accent-soft);
  }

  /* ── Popovers ────────────────────────────────────────────── */

  .popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    background: var(--bg-panel);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow);
  }

  .popover.right {
    left: auto;
    right: 0;
  }

  .editor {
    width: 190px;
    padding: 8px;
  }

  .editor-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }

  .editor-label {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
  }

  .editor-value {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
  }

  .menu {
    display: flex;
    flex-direction: column;
    min-width: 130px;
    padding: 4px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
    text-align: left;
    color: var(--text);
    white-space: nowrap;
  }

  .menu-item:hover {
    background: var(--bg-hover);
  }

  .menu-item.danger {
    color: var(--danger);
  }

  /* ── Footer ──────────────────────────────────────────────── */

  .footer {
    gap: 4px;
  }

  .play {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: 50%;
    background: linear-gradient(
      160deg,
      var(--accent-hover),
      var(--accent) 65%,
      #cf922e
    );
    color: var(--accent-contrast);
    box-shadow: 0 2px 8px rgba(229, 168, 62, 0.35);
    margin-right: 4px;
    transition: transform 0.13s;
  }

  .play:hover {
    transform: scale(1.06);
  }

  .lap {
    position: absolute;
    top: -5px;
    right: -9px;
    background: var(--accent);
    color: var(--accent-contrast);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 700;
    line-height: 1.2;
    padding: 1px 4px;
    border-radius: var(--radius-pill);
    white-space: nowrap;
  }

  .countdown {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: 11px;
    font-weight: 700;
  }

  .add-param {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
  }

  .add-param:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  /* Repeat editor: horizontal strip of value buttons. */
  .value-strip {
    display: flex;
    gap: 2px;
  }

  .flyout-item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
  }

  .flyout-item:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .flyout-item.sel {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }

  .spacer {
    flex: 1;
  }
</style>
