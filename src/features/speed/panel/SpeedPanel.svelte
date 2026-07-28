<script lang="ts">
  import Panel from '@/ui/Panel.svelte';
  import SliderRow from '@/ui/SliderRow.svelte';
  import Stepper from '@/ui/shared/Stepper.svelte';
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
    <button
      type="button"
      class={[
        'relative flex-none rounded-[7px] border px-2.25 py-1 font-mono text-[10px] font-bold tracking-[0.08em]',
        session.bpmDetecting
          ? 'detecting text-accent-ink border-accent-line bg-accent-softer'
          : 'text-muted border-line-strong ghost active:not-disabled:bg-inset active:not-disabled:text-accent',
      ]}
      aria-label={session.bpmDetecting ? 'Detecting tempo' : 'Detect tempo'}
      aria-busy={session.bpmDetecting}
      disabled={!canDetect}
      onclick={() => session.detectBpm()}
      {@attach tooltip(
        session.bpmNoResult
          ? "Couldn't detect a tempo — try a louder or more rhythmic section"
          : 'Measure the tempo of the playing audio',
      )}
    >
      <!-- The label stays in the DOM (hidden while detecting) so the button
           keeps a constant width; the meter overlays it in fixed columns. -->
      <span class="detect-label">DETECT</span>
      {#if session.bpmDetecting}
        <span class="eq" aria-hidden="true">
          <i class="bar"></i>
          <i class="bar"></i>
          <i class="bar"></i>
          <i class="bar"></i>
        </span>
      {/if}
    </button>
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

<style>
  /* Hidden but still laid out → the button width stays fixed at "DETECT". */
  .detecting .detect-label {
    visibility: hidden;
  }

  /* A small spectrum meter: fixed-width bars centered over the button, so only
     their HEIGHT animates. All bars share one keyframe; per-bar animation-delay
     scatters the phase so they bob out of sync. (The keyframe name must stay in
     the `animation` shorthand — a nameless one gets minified to `none`.) */
  .eq {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 22px;
    display: flex;
    align-items: center;
  }

  .bar {
    flex: 1 1 0;
    min-width: 0;
    font-size: 9px;
    line-height: 1;
    font-style: normal;
    text-align: center;
  }

  .bar::before {
    content: '▃';
    animation: eq 1.1s steps(1, end) infinite;
  }
  .bar:nth-child(2)::before {
    animation-delay: -0.45s;
  }
  .bar:nth-child(3)::before {
    animation-delay: -0.2s;
  }
  .bar:nth-child(4)::before {
    animation-delay: -0.75s;
  }

  @keyframes eq {
    0% { content: '▁'; }
    12.5% { content: '▃'; }
    25% { content: '▅'; }
    37.5% { content: '▆'; }
    50% { content: '▇'; }
    62.5% { content: '▆'; }
    75% { content: '▅'; }
    87.5% { content: '▃'; }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar::before {
      content: '▄';
      animation: none;
    }
  }
</style>
