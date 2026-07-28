<script lang="ts">
  import { fade } from 'svelte/transition';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import Panel from '@/ui/Panel.svelte';
  import Section from '@/ui/Section.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { chords } from '@/features/chords/panel/chords.svelte';
  import { session } from '@/core/state/session.svelte';

  // Recording needs the engine-owned pipeline (direct pages, local files); in
  // other modes the strip still shows a cached chart read-only.
  const canDetect = $derived(
    session.connection === 'connected-direct' || session.connection === 'local-file',
  );
  const canAnalyze = $derived(canDetect && !session.sourceChanging && session.duration > 0);

  const key = $derived(chords.chart?.key ?? null);
  const segments = $derived(chords.chart?.segments ?? []);
  /** Tail of the detected chords — the recording screen's live glimpse. */
  const recentSegments = $derived(segments.slice(-8));
  const analyzedFrom = $derived(chords.chart?.analyzedFrom ?? 0);
  const analyzedTo = $derived(chords.chart?.analyzedTo ?? 0);
  const duration = $derived(session.duration);

  // Time axis: fixed scale, so tile width ∝ chord duration, and a fixed window
  // of the song is visible. The row is scrolled so the playhead maps to a fixed
  // "now" line (NOW_FRAC from the left — a little past, more upcoming).
  const PX_PER_SEC = 48;
  const NOW_FRAC = 0.3;
  /** Hide the label on tiles too narrow to fit one. */
  const MIN_LABEL_PX = 26;

  /** Tile under the playhead — the last chord that has started. Highlighted. */
  const currentIndex = $derived.by(() => {
    const t = session.t;
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].startT <= t) idx = i;
      else break;
    }
    return idx;
  });

  let rowEl = $state<HTMLDivElement>();
  /** Lane width, tracked via ResizeObserver (bind:clientWidth) — never read in
   * the rAF loop, so scrolling does no per-frame layout. */
  let laneWidth = $state(0);

  // Re-anchor the time prediction on every engine tick (~33 ms) and on
  // play/pause. Between ticks the rAF loop extrapolates for smooth motion.
  let anchorT = 0;
  let anchorPerf = 0;
  $effect(() => {
    session.t;
    session.playing;
    anchorT = session.t;
    anchorPerf = performance.now();
  });

  /** Predicted media time now — extrapolated while playing (at the effective
   * speed), exact when paused/scrubbing. */
  function predictedTime(): number {
    if (!session.playing) return session.t;
    const eff = session.params.speedEnabled ? session.params.speed : 1;
    const t = anchorT + ((performance.now() - anchorPerf) / 1000) * eff;
    return duration > 0 ? Math.min(duration, Math.max(0, t)) : Math.max(0, t);
  }

  // Continuous constant-speed scroll: a single write-only rAF loop set up once
  // (no reactive deps in the effect body → it isn't torn down when the chart
  // updates), doing no layout reads. `rowEl`/`laneWidth` are read inside the
  // callback (not tracked); the loop no-ops until a chart renders the row.
  $effect(() => {
    let raf = 0;
    const loop = () => {
      const el = rowEl;
      if (el) {
        const nowX = laneWidth * NOW_FRAC;
        el.style.transform = `translateX(${nowX - predictedTime() * PX_PER_SEC}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  // Auto-stop the analysis when the song ends or the user pauses / seeks.
  // Armed only once playback is rolling NEAR THE RUN'S START POSITION: a
  // from-the-top run's jumpStart is echoed back by the engine a round-trip
  // later, so right after entering the analyzing phase `session.t` may still
  // hold the old position (with `playing` already true if the song was
  // playing) — arming on that stale sample would make the jump to 0 read as a
  // user seek and instantly kill the run. (No-PCM hangs are the watchdog's job.)
  const END_EPS = 0.75;
  const ARM_WINDOW = 5;
  let runArmed = false;
  let runLastT = 0;
  let runLastPerf = 0;
  $effect(() => {
    const phase = chords.phase;
    const t = session.t; // reactive dep, ~30 Hz while connected
    const playing = session.playing;
    if (phase !== 'analyzing') {
      runArmed = false;
      return;
    }
    if (session.sourceChanging) {
      console.info('[note-by-note] chords: watcher — source changing, stopping');
      chords.stopAnalysis('seek');
      return;
    }
    if (!runArmed) {
      if (playing && Math.abs(t - chords.startT) <= ARM_WINDOW) {
        runArmed = true;
        runLastT = t;
        runLastPerf = performance.now();
        console.info('[note-by-note] chords: watcher armed', { t, startT: chords.startT });
      }
      return;
    }
    if (!playing) {
      const ended = duration > 0 && t >= duration - END_EPS;
      console.info(
        `[note-by-note] chords: watcher — playback ${ended ? 'ended' : 'paused'}`,
        { t, duration },
      );
      chords.stopAnalysis(ended ? 'ended' : 'pause');
      return;
    }
    // A jump beyond what elapsed wall time explains is a user seek (this also
    // catches a song-repeat loop wrapping at the end — stops with a full chart).
    const dt = (performance.now() - runLastPerf) / 1000;
    const eff = session.params.speedEnabled ? session.params.speed : 1;
    const expected = runLastT + dt * eff;
    if (Math.abs(t - expected) > Math.max(1.0, 2 * dt * eff)) {
      console.info('[note-by-note] chords: watcher — seek detected', {
        t,
        expected: Math.round(expected * 100) / 100,
        dt: Math.round(dt * 1000),
      });
      chords.stopAnalysis('seek');
      return;
    }
    runLastT = t;
    runLastPerf = performance.now();
  });
</script>

<Section id="tools" label="Tools">
  <Panel
    id="chords"
    value={chords.phase === 'idle' && key ? `${key.tonic} ${key.mode}` : undefined}
    enabled={chords.enabled}
    onenabledchange={(on) => chords.setEnabled(on)}
  >
    {#if chords.phase === 'confirming'}
      <div class="flex flex-col items-center gap-2 rounded-sm bg-inset px-3 py-2.5">
        <span class="text-muted text-[11px] text-center">
          Where should the analysis start? A full pass from 0:00 maps the whole song.
        </span>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="btn primary"
            onclick={() => chords.confirmAnalyze(true)}
            {@attach tooltip('Jump to 0:00 and analyze the whole song')}
          >
            From start
          </button>
          <button
            type="button"
            class="btn"
            onclick={() => chords.confirmAnalyze(false)}
            {@attach tooltip('Analyze from the current position — earlier chords stay unmapped')}
          >
            From here
          </button>
          <button type="button" class="btn ghost-btn" onclick={() => chords.cancelAnalyze()}>
            Cancel
          </button>
        </div>
      </div>
    {:else if chords.phase === 'loading'}
      <div
        class="relative h-13.5 flex items-center justify-center gap-2 rounded-sm bg-inset text-faint text-[11px]"
      >
        <span class="eq" aria-hidden="true">
          <i class="bar"></i>
          <i class="bar"></i>
          <i class="bar"></i>
          <i class="bar"></i>
        </span>
        Loading chord model…
      </div>
    {:else if chords.phase === 'analyzing'}
      <div class="relative flex flex-col gap-1.5 overflow-hidden rounded-sm bg-inset px-3 py-2.5">
        <div class="flex items-center gap-2" aria-live="polite">
          <span class="rec-dot" aria-hidden="true"></span>
          <span class="text-[11.5px] font-semibold">Analyzing…</span>
          <span class="flex-1"></span>
          <button type="button" class="btn" onclick={() => chords.stopAnalysis('manual')}>
            Stop
          </button>
        </div>
        <!-- The chords heard so far, newest right — a glimpse, not the chart.
             Right-aligned so the fresh end stays visible when the row fills. -->
        <div class="flex items-center justify-end gap-1 h-5.5 overflow-hidden">
          {#if recentSegments.length}
            {#each recentSegments as seg (Math.round(seg.startT * 10))}
              <span class={['chip', { latest: seg === recentSegments[recentSegments.length - 1] }]}
                >{seg.label}</span
              >
            {/each}
          {:else}
            <span class="w-full text-center text-faint text-[10.5px]">Listening…</span>
          {/if}
        </div>
        <p class="text-faint text-[10.5px] text-center">
          Plays to the end, then shows the chart — warm up or grab a coffee.
        </p>
        <div
          class="rec-progress"
          style:width="{duration > 0 ? Math.min(1, session.t / duration) * 100 : 0}%"
        ></div>
      </div>
    {:else if chords.hasChart}
      <div class="relative h-13.5 overflow-hidden rounded-sm bg-inset" bind:clientWidth={laneWidth}>
        <div class="absolute top-2 left-0 h-9.5 will-change-transform" bind:this={rowEl}>
          {#if analyzedFrom > 0}
            <div
              class="pending"
              style:left="0px"
              style:width="{analyzedFrom * PX_PER_SEC}px"
            ></div>
          {/if}
          {#if duration > analyzedTo}
            <div
              class="pending"
              style:left="{analyzedTo * PX_PER_SEC}px"
              style:width="{(duration - analyzedTo) * PX_PER_SEC}px"
            ></div>
          {/if}
          {#each segments as seg, i (seg.startT)}
            {@const w = (seg.endT - seg.startT) * PX_PER_SEC}
            <!-- Newly-revealed chords fade in (local transition → no
                 mass-fade of an already-cached chart on first render). -->
            <div
              class="tile"
              class:current={i === currentIndex}
              style:left="{seg.startT * PX_PER_SEC}px"
              style:width="{w}px"
              in:fade={{ duration: 220 }}
            >
              {#if w >= MIN_LABEL_PX}<span class="overflow-hidden text-ellipsis">{seg.label}</span
                >{/if}
            </div>
          {/each}
        </div>
        <div class="nowline" style:left="{NOW_FRAC * 100}%"></div>
        <div class="edge left" aria-hidden="true"></div>
        <div class="edge right" aria-hidden="true"></div>
      </div>
      <!-- Actions below the lane, like the Looper's toolbar under its timeline. -->
      <div class="flex items-center pt-2">
        <button
          type="button"
          class="btn rec-btn"
          disabled={!canAnalyze}
          onclick={() => chords.requestAnalyze()}
          {@attach tooltip('Analyze again — replaces the current chords')}
        >
          <span class="rec-dot" aria-hidden="true"></span>
          ANALYZE
        </button>
        <span class="flex-1"></span>
        <IconButton
          icon="trash"
          label="Clear detected chords"
          danger
          size={15}
          onclick={() => chords.clear()}
        />
      </div>
    {:else if canDetect}
      <div class="flex flex-col items-center gap-1.5 rounded-sm bg-inset px-3 py-2.5">
        <p class="text-muted text-[11px] text-center">
          No chords for this song yet.
        </p>
        <button
          type="button"
          class="btn rec-btn"
          disabled={!canAnalyze}
          onclick={() => chords.requestAnalyze()}
          {@attach tooltip('Play the song once from start to finish to detect its chords')}
        >
          <span class="rec-dot" aria-hidden="true"></span>
          ANALYZE
        </button>
        <p class="text-faint text-[10.5px] text-center">
          Plays the song once and listens — the chords and key appear when it finishes.
        </p>
        {#if chords.loadError}
          <span class="text-danger text-[10.5px]">Couldn't load the chord model — try again</span>
        {/if}
      </div>
    {:else}
      <div
        class="relative h-13.5 flex items-center justify-center rounded-sm bg-inset text-faint text-[11px]"
      >
        Chord detection needs direct playback
      </div>
    {/if}
  </Panel>
</Section>

<style>
  /* Compact action buttons (mirrors the Speed panel's DETECT/TAP styling). */
  .btn {
    flex: none;
    border-radius: 7px;
    border: 1px solid var(--border-strong);
    padding: 4px 9px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .btn:not(:disabled):active {
    background: var(--bg-inset);
    color: var(--accent);
  }
  .btn.primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-contrast);
  }
  /* Dismiss action — present but visually last in line. */
  .btn.ghost-btn {
    border-color: transparent;
    color: var(--text-faint);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Recording indicator: a small pulsing red dot. */
  .rec-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--danger);
    animation: pulse 1s ease-in-out infinite;
  }

  /* The classic "● REC" affordance: outlined button, steady red dot. */
  .rec-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .rec-btn .rec-dot {
    animation: none;
  }

  /* Chords heard so far, as plain chips (the timeline appears after Stop);
     the newest chip carries the accent. */
  .chip {
    flex: none;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-panel);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .chip.latest {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-contrast);
  }

  /* Playhead progress through the song, along the inset's bottom edge. */
  .rec-progress {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    background: var(--accent);
    opacity: 0.7;
    transition: width 0.3s linear;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* A small spectrum meter while the model loads: fixed-width bars whose
     HEIGHT animates. All bars share one keyframe; per-bar animation-delay
     scatters the phase so they bob out of sync. (The keyframe name must stay
     in the `animation` shorthand — a nameless one gets minified to `none`.) */
  .eq {
    flex: none;
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
    color: var(--text-faint);
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
    .rec-dot {
      animation: none;
    }
    .bar::before {
      content: '▄';
      animation: none;
    }
  }

  .tile {
    position: absolute;
    top: 0;
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 0 2px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-panel);
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    overflow: hidden;
    white-space: nowrap;
    /* Fade the highlight in/out as a chord becomes / stops being current. */
    transition:
      background-color 0.3s ease,
      border-color 0.3s ease,
      color 0.3s ease;
  }
  .tile.current {
    background: linear-gradient(160deg, var(--accent), #d19430);
    border-color: transparent;
    color: var(--accent-contrast);
    font-weight: 800;
    box-shadow:
      0 3px 14px rgba(229, 168, 62, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
  }

  @media (prefers-reduced-motion: reduce) {
    .tile {
      transition: none;
    }
  }

  /* Not-yet-analyzed spans: faint diagonal hatch. */
  .pending {
    position: absolute;
    top: 0;
    height: 38px;
    border-radius: var(--radius-sm);
    background: repeating-linear-gradient(
      45deg,
      var(--track) 0 5px,
      transparent 5px 10px
    );
    opacity: 0.35;
  }

  /* Fixed playhead marker — a cream line so it reads over the amber current
     tile it sits on. */
  .nowline {
    position: absolute;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: 1px;
    transform: translateX(-1px);
    background: var(--text);
    opacity: 0.85;
    box-shadow: 0 0 8px rgba(240, 233, 219, 0.5);
    pointer-events: none;
  }

  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 22px;
    pointer-events: none;
  }
  .edge.left {
    left: 0;
    background: linear-gradient(to right, var(--bg-inset), transparent);
  }
  .edge.right {
    right: 0;
    background: linear-gradient(to left, var(--bg-inset), transparent);
  }
</style>
