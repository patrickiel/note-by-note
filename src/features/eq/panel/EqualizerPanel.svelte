<script lang="ts">
  import Panel from '@/ui/Panel.svelte';
  import Dropdown from '@/ui/shared/Dropdown.svelte';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { eqResponseCurve } from '@/features/eq/panel/eq-response';
  import {
    BUILTIN_EQ_PRESETS,
    EQ_BANDS,
    EQ_GAIN_LIMIT,
  } from '@/core/model/defaults';
  import { eqPresets } from '@/features/eq/panel/eq-presets.svelte';
  import { session } from '@/core/state/session.svelte';

  /** Dropdown value for a hand-edited curve. Not a real name — preset names are
   * trimmed and non-empty, so this can't collide. */
  const CUSTOM = '';

  let enabled = $derived(session.params.eq.enabled);
  // The EQ is the last stage of the DSP chain, so it's inert when that never attached.
  let blocked = $derived(!session.dspAvailable);
  let dirty = $derived(session.params.eq.gains.some((g) => g !== 0));

  /** null while the curve matches no preset (i.e. Custom). */
  let presetName = $derived(eqPresets.match(session.params.eq.gains));

  let presetOptions = $derived([
    ...(presetName === null ? [{ value: CUSTOM, label: 'Custom' }] : []),
    ...eqPresets.all.map((p) => ({ value: p.name, label: p.name })),
  ]);

  /** Measured px width of the curve box. The viewBox is sized to match it 1:1 so
   * the scale stays uniform: `preserveAspectRatio="none"` + non-scaling-stroke
   * draws hairlines in Chrome but collapses them to near-nothing in Firefox.
   * Measured on the wrapper — `clientWidth` on an <svg> reads 0 in Firefox. */
  let curveWidth = $state(0);

  // True combined biquad response, so the drawn curve matches the audio.
  let curvePoints = $derived(
    eqResponseCurve(session.params.eq.gains)
      .map(({ x, db }) => {
        const clamped = Math.max(-EQ_GAIN_LIMIT, Math.min(EQ_GAIN_LIMIT, db));
        const y = 24 - (clamped / EQ_GAIN_LIMIT) * 22;
        return `${(x * curveWidth).toFixed(2)},${y}`;
      })
      .join(' '),
  );

  function bandLabel(hz: number): string {
    return hz >= 1000 ? `${hz / 1000}k` : String(Math.floor(hz));
  }

  function setEnabled(on: boolean) {
    session.patchParams({
      eq: { enabled: on, gains: session.params.eq.gains.slice() },
    });
  }

  function setGain(index: number, gain: number) {
    const gains = session.params.eq.gains.slice();
    gains[index] = gain;
    session.patchParams({ eq: { enabled: session.params.eq.enabled, gains } });
  }

  /** Zeroes the gains without touching the on/off switch. */
  function resetGains() {
    session.patchParams({
      eq: { enabled: session.params.eq.enabled, gains: EQ_BANDS.map(() => 0) },
    });
  }

  function applyPreset(name: string) {
    const preset = eqPresets.all.find((p) => p.name === name);
    if (!preset) return; // the Custom entry — selecting it changes nothing.
    // Normalize the length so a preset saved under a different band count can't
    // leave stale entries behind.
    const gains = EQ_BANDS.map((_, i) => preset.gains[i] ?? 0);
    // Switch the EQ on, or picking a preset while bypassed would do nothing
    // audible. Flat is the exception: it's the "no effect" curve.
    session.patchParams({
      eq: { enabled: name === 'Flat' ? enabled : true, gains },
    });
  }

  let naming = $state(false);
  let draft = $state('');
  // Built-in names are taken: `match` resolves them to the built-in, so a user
  // preset sharing one could never be selected back.
  let nameTaken = $derived(
    BUILTIN_EQ_PRESETS.some((p) => p.name === draft.trim()),
  );

  function beginNaming() {
    draft = '';
    naming = true;
  }

  /** Saves under the typed name; an existing one is overwritten, which is how
   * you edit or rename a preset. */
  function commitName() {
    if (!naming) return;
    naming = false;
    const name = draft.trim();
    if (!name || nameTaken) return;
    void eqPresets.save(name, session.params.eq.gains.slice());
  }

  function onNameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !nameTaken) commitName();
    if (event.key === 'Escape') naming = false;
  }

  function focusInput(node: HTMLInputElement) {
    node.focus();
  }

  let { grouped = false }: { grouped?: boolean } = $props();
</script>

<Panel
  id="equalizer"
  {enabled}
  onenabledchange={setEnabled}
  onreset={resetGains}
  resettable={dirty}
  {grouped}
  unavailable={blocked}
>
  <div>
      <!-- `.preset-row` is kept as a hook: the select is stretched via :global. -->
      <div class="preset-row flex items-center gap-0.5 min-h-6.5 mb-1">
        {#if naming}
          <input
            class="flex-1 min-w-0 px-1.5 py-0.75 bg-inset border border-accent-ink rounded-sm text-fg text-[13px] font-semibold outline-none placeholder:text-faint placeholder:font-normal aria-invalid:border-danger"
            bind:value={draft}
            placeholder="Preset name"
            aria-label="New preset name"
            aria-invalid={nameTaken}
            disabled={blocked}
            {@attach tooltip(nameTaken ? `${draft.trim()} is a built-in preset` : '')}
            onblur={commitName}
            onkeydown={onNameKeydown}
            {@attach focusInput}
          />
        {:else}
          <Dropdown
            options={presetOptions}
            value={presetName ?? CUSTOM}
            label="EQ preset"
            disabled={blocked}
            onchange={applyPreset}
          />
          {#if presetName === null}
            <IconButton
              icon="plus"
              label="Save curve as a preset"
              size={15}
              disabled={blocked}
              onclick={beginNaming}
            />
          {:else if eqPresets.isSaved(presetName)}
            <IconButton
              icon="trash"
              label="Delete preset {presetName}"
              size={15}
              danger
              disabled={blocked}
              onclick={() => void eqPresets.remove(presetName)}
            />
          {/if}
        {/if}
      </div>

      <div class="mb-1.5" bind:clientWidth={curveWidth}>
        <svg class="block w-full h-12" viewBox="0 0 {curveWidth || 1} 48" aria-hidden="true">
          <line class="midline" x1="0" y1="24" x2={curveWidth} y2="24" />
          <polyline class="gain-line" points={curvePoints} />
        </svg>
      </div>

      <div class="flex justify-between gap-0.5">
        {#each EQ_BANDS as hz, i (hz)}
          <div class="flex flex-col items-center gap-0.5 min-w-0">
            <div class="band">
              <input
                type="range"
                min={-EQ_GAIN_LIMIT}
                max={EQ_GAIN_LIMIT}
                step="0.5"
                value={session.params.eq.gains[i] ?? 0}
                disabled={!enabled || blocked}
                aria-label="EQ {hz} Hz gain"
                {@attach tooltip(
                  `${bandLabel(hz)} — ${(session.params.eq.gains[i] ?? 0).toFixed(1)} dB`,
                )}
                oninput={(e) => setGain(i, Number(e.currentTarget.value))}
                ondblclick={() => setGain(i, 0)}
              />
            </div>
            <span class="font-mono text-[10px] text-muted">{bandLabel(hz)}</span>
          </div>
        {/each}
      </div>
  </div>
</Panel>

<style>
  /* Fill the row so the trailing icon button stays put as the selected
     preset's name changes the select's intrinsic width. */
  .preset-row :global(select) {
    flex: 1;
    min-width: 0;
  }

  /* Cap the shared 30px icon button at the row's reserved height, or the save /
     delete button appearing alongside the header's reset icon would grow the
     row — and with it the whole panel — by 4px. */
  .preset-row :global(.icon-btn) {
    width: 26px;
    height: 26px;
  }

  .midline {
    stroke: var(--track);
    stroke-width: 1;
  }

  .gain-line {
    fill: none;
    stroke: var(--accent-ink);
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  /* Vertical slider: horizontal input rotated inside a fixed-size box, so the
     shared horizontal track/thumb styling applies unchanged. */
  .band {
    position: relative;
    width: 22px;
    height: 76px;
  }

  .band input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    position: absolute;
    top: 50%;
    left: 50%;
    width: 76px;
    height: 22px;
    margin: 0;
    transform: translate(-50%, -50%) rotate(-90deg);
    background: transparent;
    cursor: pointer;
  }

  .band input[type='range']:disabled {
    cursor: default;
  }

  .band input[type='range']::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 2px;
    background: var(--track);
  }

  .band input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4.5px;
    border-radius: 50%;
    background: var(--thumb);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }

  /* Firefox counterparts. `-moz-range-progress` would otherwise paint a native
     fill over the track half below the thumb; the thumb self-centres, so it
     needs no margin. */
  .band input[type='range']::-moz-range-track {
    height: 3px;
    border-radius: 2px;
    background: var(--track);
  }

  .band input[type='range']::-moz-range-progress {
    background: transparent;
  }

  .band input[type='range']::-moz-range-thumb {
    width: 12px;
    height: 12px;
    /* Firefox gives the thumb a native border that the `*` reset can't reach. */
    border: none;
    border-radius: 50%;
    background: var(--thumb);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
</style>
