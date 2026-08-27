<script lang="ts">
  import Panel from '@/ui/Panel.svelte';
  import SliderRow from '@/ui/SliderRow.svelte';
  import Stepper from '@/ui/shared/Stepper.svelte';
  import DetectButton from '@/ui/shared/DetectButton.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { DEFAULT_PARAMS } from '@/core/model/defaults';
  import { formatSpeedPct } from '@/core/model/format';
  import { session } from '@/core/state/session.svelte';

  let { grouped = false }: { grouped?: boolean } = $props();

  const RESET_KEYS = ['speed', 'baseBpm'] as const;

  let enabled = $derived(session.params.speedEnabled);
  let dirty = $derived(!session.isDefault([...RESET_KEYS]));
  // Rate the element actually plays at (bypassed speed = native 1×).
  let effSpeed = $derived(enabled ? session.params.speed : 1);

  // Auto-detect is only meaningful where the engine owns the audio pipeline and
  // playback rate (direct pages, local files) and something is playing.
  let canDetect = $derived(
    !session.bpmDetecting &&
      session.playing &&
      (session.connection === 'connected-direct' ||
        session.connection === 'local-file'),
  );

  function effectiveBpm(baseBpm: number | null): string {
    return baseBpm != null ? String(Math.round(baseBpm * effSpeed)) : '';
  }

  let bpmDisplay = $derived(effectiveBpm(session.params.baseBpm));

  function onBpmChange(event: Event & { currentTarget: HTMLInputElement }) {
    const n = Number(event.currentTarget.value.trim());
    const baseBpm = Number.isFinite(n) && n > 0 ? n : null;
    session.patchParams({ baseBpm });
    event.currentTarget.value = effectiveBpm(baseBpm);
  }

  // Steps the effective bpm on screen; baseBpm back-solves from it.
  function stepBpm(delta: number) {
    const { baseBpm } = session.params;
    if (baseBpm == null) return;
    const next = Math.round(baseBpm * effSpeed) + delta;
    if (next > 0) session.patchParams({ baseBpm: next / effSpeed });
  }

  // Tap-tempo: taps follow the audible tempo (already at the current speed),
  // so we divide out effSpeed before storing the base.
  const TAP_RESET_MS = 2000;
  let taps: number[] = [];
  let tapResetTimer: ReturnType<typeof setTimeout> | undefined;

  function tapTempo() {
    const now = Date.now();
    // A long gap means a new tempo — start the sequence over.
    if (taps.length && now - taps[taps.length - 1] > TAP_RESET_MS) taps = [];
    taps.push(now);
    // Keep a short window so the tempo tracks the most recent taps.
    if (taps.length > 8) taps = taps.slice(-8);

    if (taps.length >= 2) {
      const avgInterval = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      session.patchParams({ baseBpm: 60000 / avgInterval / effSpeed });
    }

    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(() => (taps = []), TAP_RESET_MS);
  }
</script>

{#snippet tempoTools()}
  <!-- Tempo tools sit on their own row under the slider, split off by a dashed
       divider (matches the mockup's Speed layout). Collapsed by default. -->
  <div class="flex items-center gap-1.5 border-t border-dashed border-line pt-2.5">
    <DetectButton
      detecting={session.bpmDetecting}
      disabled={!canDetect}
      subject="tempo"
      hint="Measure the tempo of the playing audio"
      noResult={session.bpmNoResult}
      noResultHint="Couldn't detect a tempo — try a louder or more rhythmic section"
      onclick={() => session.detectBpm()}
    />
    <button
      type="button"
      class="flex-none rounded-[7px] border border-line-strong px-2.25 py-1 font-mono text-[10px] font-bold tracking-[0.08em] text-muted ghost active:not-disabled:bg-inset active:not-disabled:text-accent"
      aria-label="Tap tempo"
      onclick={tapTempo}
      {@attach tooltip('Tap in time with the beat to set the tempo')}
    >
      TAP
    </button>
    <span class="flex-1"></span>
    <Stepper
      direction={-1}
      disabled={session.params.baseBpm == null}
      label="Decrease tempo"
      onstep={() => stepBpm(-1)}
    />
    <input
      class="num-input"
      type="text"
      inputmode="numeric"
      placeholder="bpm"
      aria-label="Tempo in bpm"
      value={bpmDisplay}
      onchange={onBpmChange}
      {@attach tooltip('Base tempo in bpm; shows the effective tempo at the current speed')}
    />
    <Stepper
      direction={1}
      disabled={session.params.baseBpm == null}
      label="Increase tempo"
      onstep={() => stepBpm(1)}
    />
  </div>
{/snippet}

<Panel
  id="speed"
  value={formatSpeedPct(session.params.speed)}
  {enabled}
  {grouped}
  onenabledchange={(on) => session.patchParams({ speedEnabled: on })}
  onreset={() => session.resetParam([...RESET_KEYS])}
  resettable={dirty}
  details={tempoTools}
>
  <SliderRow
    value={Math.round(session.params.speed * 100)}
    min={25}
    max={200}
    step={1}
    stepButton={5}
    defaultValue={DEFAULT_PARAMS.speed * 100}
    disabled={!enabled}
    label="Speed (percent)"
    downAction="speedDown"
    upAction="speedUp"
    onchange={(pct) => session.patchParams({ speed: pct / 100 })}
  />
</Panel>

