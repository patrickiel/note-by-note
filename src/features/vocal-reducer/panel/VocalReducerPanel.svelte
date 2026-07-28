<script lang="ts">
  import Panel from '@/ui/Panel.svelte';
  import Slider from '@/ui/shared/Slider.svelte';
  import { session } from '@/core/state/session.svelte';
  import { settings } from '@/features/settings/panel/settings.svelte';
  import { DEFAULT_SETTINGS } from '@/core/model/defaults';

  const RESET_KEYS = ['vocalReduce', 'vocalMode'] as const;

  let enabled = $derived(session.params.vocalReduceEnabled);
  // The reducer is a stage of the DSP chain, so it's inert when that never attached.
  let blocked = $derived(!session.dspAvailable);
  let amountPct = $derived(Math.round(session.params.vocalReduce * 100));
  let isolate = $derived(session.params.vocalMode === 'isolate');
  // Bipolar position: left (−) reduces, right (+) isolates, centre (0) is off.
  let sliderValue = $derived(isolate ? amountPct : -amountPct);
  // "Natural vocals" = formant preservation, a global setting applied while
  // pitch-shifting (see pipeline.setFormantPreserved).
  let natural = $derived(settings.current.formantPreserved);
  // Reset clears the reduce params and the Natural toggle together, so the
  // reset affordance appears when either is off its default.
  let dirty = $derived(
    !session.isDefault([...RESET_KEYS]) ||
      natural !== DEFAULT_SETTINGS.formantPreserved,
  );

  let { grouped = false }: { grouped?: boolean } = $props();

  function onSlider(v: number) {
    session.patchParams({
      vocalReduce: Math.abs(v) / 100,
      vocalMode: v > 0 ? 'isolate' : 'reduce',
    });
  }

  function reset() {
    session.resetParam([...RESET_KEYS]);
    if (natural !== DEFAULT_SETTINGS.formantPreserved) {
      void settings.update({ formantPreserved: DEFAULT_SETTINGS.formantPreserved });
    }
  }
</script>

{#snippet naturalTool()}
  <!-- Formant preservation ("Natural") sits on its own row, split off by a dashed
       divider like the Speed panel's tempo tools. The button mirrors DETECT/TAP;
       the space to its right carries the explanation that used to live only in
       the tooltip. Collapsed by default. -->
  <div class="flex items-center gap-2.5 border-t border-dashed border-line pt-2.5">
    <button
      type="button"
      class={[
        'flex-none rounded-[7px] border px-2.25 py-1 font-mono text-[10px] font-bold tracking-[0.08em]',
        natural
          ? 'text-accent-contrast border-transparent bg-accent'
          : 'text-muted border-line-strong ghost active:not-disabled:bg-inset active:not-disabled:text-accent',
      ]}
      role="switch"
      aria-checked={natural}
      aria-label="Natural vocals"
      disabled={blocked}
      onclick={() => void settings.update({ formantPreserved: !natural })}
    >
      NATURAL
    </button>
    <p class="text-[12px] leading-snug text-muted">
      Only matters when pitch shifting. Keeps voices natural, not chipmunky. Best
      for singing; can dull instrumentals.
    </p>
  </div>
{/snippet}

<Panel
  id="vocalReducer"
  value={amountPct === 0 ? 'Off' : `${isolate ? 'Isolate' : 'Reduce'} ${amountPct}%`}
  {enabled}
  onenabledchange={(on) => session.patchParams({ vocalReduceEnabled: on })}
  onreset={reset}
  resettable={dirty}
  {grouped}
  unavailable={blocked}
  details={naturalTool}
>
  <div class="flex items-center gap-2">
    <span class="w-11 shrink-0 text-[11px] font-semibold text-muted select-none">Reduce</span>
    <Slider
      value={sliderValue}
      min={-100}
      max={100}
      step={1}
      defaultValue={0}
      disabled={!enabled || blocked}
      label="Vocals: drag left to reduce, right to isolate"
      onchange={onSlider}
    />
    <span
      class="w-11 shrink-0 text-right text-[11px] font-semibold text-muted select-none"
    >Isolate</span>
  </div>
</Panel>
