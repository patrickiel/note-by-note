<script lang="ts">
  import Panel from '@/ui/Panel.svelte';
  import SliderRow from '@/ui/SliderRow.svelte';
  import Stepper from '@/ui/shared/Stepper.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { DEFAULT_PARAMS, PITCH_CENTS_RANGE } from '@/core/model/defaults';
  import { centsToHz } from '@/core/model/format';
  import { session } from '@/core/state/session.svelte';
  import { settings } from '@/features/settings/panel/settings.svelte';

  let { grouped = false }: { grouped?: boolean } = $props();

  type TuningKey = 'trackHz' | 'instrumentHz';

  const ROWS: { key: TuningKey; label: string }[] = [
    { key: 'trackHz', label: 'Track' },
    { key: 'instrumentHz', label: 'Instrument' },
  ];

  const RESET_KEYS = ['pitchCents', 'tuning'] as const;

  let enabled = $derived(session.params.pitchEnabled);
  let dirty = $derived(!session.isDefault([...RESET_KEYS]));
  // Pitch shifting lives in the DSP chain, so it's inert when that never attached.
  let blocked = $derived(!session.dspAvailable);

  let readout = $derived(
    settings.current.pitchDisplay === 'hz'
      ? `${centsToHz(session.params.pitchCents, 440).toFixed(1)} Hz`
      : String(session.params.pitchCents),
  );

  function setTuning(key: TuningKey, hz: number) {
    session.patchParams({ tuning: { ...session.params.tuning, [key]: hz } });
  }

  function onHzChange(
    key: TuningKey,
    event: Event & { currentTarget: HTMLInputElement },
  ) {
    const n = Number(event.currentTarget.value);
    if (Number.isFinite(n) && n > 0) setTuning(key, Math.round(n));
    event.currentTarget.value = String(session.params.tuning[key]);
  }
</script>

{#snippet tuningSection()}
  <div class="border-t border-dashed border-line pt-2.5">
    <div class="px-0.5 pb-1.5 text-[10.5px] font-bold tracking-widest uppercase text-faint">
      Reference tuning
    </div>
    {#each ROWS as row (row.key)}
      <div class="flex items-center gap-1.5 py-0.75">
        <span class="flex-1 min-w-0 text-muted text-[12.5px]">{row.label}</span>
        <Stepper
          direction={-1}
          disabled={!enabled || blocked}
          label="Decrease {row.label} tuning"
          onstep={() => setTuning(row.key, session.params.tuning[row.key] - 1)}
        />
        <input
          class="num-input"
          type="text"
          inputmode="numeric"
          disabled={!enabled || blocked}
          aria-label="{row.label} tuning in Hz"
          value={session.params.tuning[row.key]}
          onchange={(e) => onHzChange(row.key, e)}
          {@attach tooltip(`${row.label} reference A4 in Hz`)}
        />
        <span class="text-[10.5px] text-faint font-mono">Hz</span>
        <Stepper
          direction={1}
          disabled={!enabled || blocked}
          label="Increase {row.label} tuning"
          onstep={() => setTuning(row.key, session.params.tuning[row.key] + 1)}
        />
      </div>
    {/each}
  </div>
{/snippet}

<Panel
  id="pitch"
  value={readout}
  {enabled}
  {grouped}
  unavailable={blocked}
  onenabledchange={(on) => session.patchParams({ pitchEnabled: on })}
  onreset={() => session.resetParam([...RESET_KEYS])}
  resettable={dirty}
  details={tuningSection}
>
  <SliderRow
    value={session.params.pitchCents}
    min={-PITCH_CENTS_RANGE}
    max={PITCH_CENTS_RANGE}
    step={1}
    defaultValue={DEFAULT_PARAMS.pitchCents}
    disabled={!enabled || blocked}
    label="Pitch (cents)"
    downAction="pitchDown"
    upAction="pitchUp"
    onchange={(v) => session.patchParams({ pitchCents: v })}
  />
</Panel>
