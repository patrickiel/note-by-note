<script lang="ts">
  import Panel from '@/ui/Panel.svelte';
  import SliderRow from '@/ui/SliderRow.svelte';
  import Stepper from '@/ui/shared/Stepper.svelte';
  import DetectButton from '@/ui/shared/DetectButton.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { DEFAULT_PARAMS, PITCH_CENTS_RANGE } from '@/core/model/defaults';
  import { centsToHz } from '@/core/model/format';
  import { session } from '@/core/state/session.svelte';
  import { settings } from '@/features/settings/panel/settings.svelte';

  let { grouped = false }: { grouped?: boolean } = $props();

  type TuningKey = 'trackHz' | 'instrumentHz';

  /** `name` is the accessible/tooltip noun ("Song tuning in Hz"). */
  const ROWS: { key: TuningKey; label: string; name: string; hint: string }[] = [
    { key: 'trackHz', label: 'Song', name: 'Song', hint: "The song's reference A4 in Hz" },
    {
      key: 'instrumentHz',
      label: 'Change to',
      name: 'Target',
      hint: 'Reference A4 in Hz to change the song to',
    },
  ];

  const RESET_KEYS = ['pitchCents', 'tuning'] as const;

  let enabled = $derived(session.params.pitchEnabled);
  let dirty = $derived(!session.isDefault([...RESET_KEYS]));
  // Pitch shifting lives in the DSP chain, so it's inert when that never attached.
  let blocked = $derived(!session.dspAvailable);

  // Auto-detect is only meaningful where the engine owns the audio pipeline
  // (direct pages, local files) and something is playing.
  let canDetect = $derived(
    !session.tuningDetecting &&
      session.playing &&
      (session.connection === 'connected-direct' ||
        session.connection === 'local-file'),
  );

  // The reference-tuning correction, in cents (what the engine adds on top of
  // the fine-tune — see netSemitones). The slider shows the SUM so a detected
  // tuning visibly moves it; dragging still edits the fine-tune underneath.
  let tuningCents = $derived(
    Math.round(
      1200 * Math.log2(session.params.tuning.instrumentHz / session.params.tuning.trackHz),
    ),
  );
  let effectiveCents = $derived(session.params.pitchCents + tuningCents);

  let readout = $derived(
    settings.current.pitchDisplay === 'hz'
      ? `${centsToHz(effectiveCents, 440).toFixed(1)} Hz`
      : String(effectiveCents),
  );

  function onSliderChange(effective: number) {
    const cents = Math.max(
      -PITCH_CENTS_RANGE,
      Math.min(PITCH_CENTS_RANGE, Math.round(effective - tuningCents)),
    );
    session.patchParams({ pitchCents: cents });
  }

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

{#snippet headerActions()}
  <!-- Lives in the header (left of the chevron) so the song's tuning can be
       measured without expanding the reference-tuning section. -->
  <DetectButton
    detecting={session.tuningDetecting}
    disabled={!canDetect || !enabled || blocked}
    label="TUNE"
    subject="song tuning"
    hint="Detect the song's tuning and correct it to your reference"
    noResult={session.tuningNoResult}
    noResultHint="No clear tuning found — try a more melodic section"
    onclick={() => session.detectTuning()}
  />
{/snippet}

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
          label="Decrease {row.name} tuning"
          onstep={() => setTuning(row.key, session.params.tuning[row.key] - 1)}
        />
        <input
          class="num-input"
          type="text"
          inputmode="numeric"
          disabled={!enabled || blocked}
          aria-label="{row.name} tuning in Hz"
          value={session.params.tuning[row.key]}
          onchange={(e) => onHzChange(row.key, e)}
          {@attach tooltip(row.hint)}
        />
        <span class="text-[10.5px] text-faint font-mono">Hz</span>
        <Stepper
          direction={1}
          disabled={!enabled || blocked}
          label="Increase {row.name} tuning"
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
  actions={headerActions}
  details={tuningSection}
>
  <!-- Slider shows fine-tune + tuning correction; its double-click default is
       the bare tuning correction (i.e. fine-tune back to 0, tuning kept). -->
  <SliderRow
    value={effectiveCents}
    min={-PITCH_CENTS_RANGE}
    max={PITCH_CENTS_RANGE}
    step={1}
    defaultValue={DEFAULT_PARAMS.pitchCents + tuningCents}
    disabled={!enabled || blocked}
    label="Pitch (cents)"
    downAction="pitchDown"
    upAction="pitchUp"
    onchange={onSliderChange}
  />
</Panel>
