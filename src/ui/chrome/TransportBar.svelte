<script lang="ts">
  import Icon from '@/ui/shared/Icon.svelte';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import Slider from '@/ui/shared/Slider.svelte';
  import { dismissable } from '@/ui/dismiss';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import { formatClock, formatTimeDisplay } from '@/core/model/format';
  import type { TimeDisplayFormat } from '@/core/model/types';
  import { session } from '@/core/state/session.svelte';
  import { settings } from '@/features/settings/panel/settings.svelte';

  const TIME_FORMATS: TimeDisplayFormat[] = [
    'mm:ss.cc',
    'hh:mm:ss',
    'seconds',
    'remaining',
  ];

  let volumeOpen = $state(false);

  let seekInterval = $derived(settings.current.seekInterval);
  const songActive = $derived(session.loop.mode?.kind === 'song' && session.loop.active);

  function cycleTimeFormat() {
    const i = TIME_FORMATS.indexOf(settings.current.timeDisplayFormat);
    settings.update({
      timeDisplayFormat: TIME_FORMATS[(i + 1) % TIME_FORMATS.length],
    });
  }


</script>

<!-- Row pinned to the bar height so the oversized (raised) play button can't
     stretch the implicit row and drag the other controls off-centre. -->
<div class="transport grid grid-cols-[1fr_auto_1fr] grid-rows-[44px] items-center gap-1 h-11 px-2.5 border-t border-line shrink-0 @container">
  <div class="flex items-center gap-1 justify-self-start">
    <IconButton
      icon="skipToStart"
      label="Jump to start"
      action="jumpStart"
      onclick={() => session.jumpStart()}
    />
    <IconButton
      icon="rewind"
      label="Rewind {seekInterval}s"
      action="seekBack"
      onclick={() => session.skip(-seekInterval)}
    />
    <!-- The primary transport action: a glowing amber disc that rides up over
         the bar's top edge into the content above (base-colored ring carves it
         out cleanly). The accent's contrast ink draws the play/pause glyph. -->
    <button
      type="button"
      class="play-btn relative z-10 -top-1.5 inline-flex items-center justify-center size-13 rounded-full text-accent-contrast mx-1 transition-transform duration-120 hover:scale-105 active:scale-95"
      aria-label={session.playing ? 'Pause' : 'Play'}
      onclick={() => session.togglePlay()}
      {@attach tooltip(session.playing ? 'Pause' : 'Play', { action: 'playPause' })}
    >
      <Icon name={session.playing ? 'pause' : 'play'} size={24} />
    </button>
    <IconButton
      icon="forward"
      label="Forward {seekInterval}s"
      action="seekFwd"
      onclick={() => session.skip(seekInterval)}
    />
  </div>
  <button
    type="button"
    class="font-mono text-[15px] text-muted tabular-nums whitespace-nowrap px-1.5 py-1 rounded-sm transition-colors duration-120 hover:bg-surface-2 hover:text-fg @max-[360px]:text-[12px]"
    aria-label="Change time format"
    onclick={cycleTimeFormat}
    {@attach tooltip('Change time format', { placement: 'top' })}
  >
    {formatTimeDisplay(session.t, session.duration, settings.current.timeDisplayFormat)}
    / {formatClock(session.duration)}
  </button>
  <div class="flex items-center gap-1 justify-self-end">
    <IconButton
      icon="repeatSong"
      label="Repeat song"
      active={songActive}
      onclick={() => session.toggleRepeatSong(!songActive)}
    />
    <div class="relative inline-flex" {@attach dismissable(() => (volumeOpen = false))}>
      <IconButton
        icon={session.volume === 0 ? 'volumeMute' : 'volume'}
        label="Volume"
        active={volumeOpen}
        onclick={() => (volumeOpen = !volumeOpen)}
      />
      {#if volumeOpen}
        <div
          class="absolute bottom-[calc(100%+8px)] right-0 flex items-center w-[130px] px-2.5 py-2 bg-surface-2 border border-line rounded-sm shadow-(--shadow) z-10"
        >
          <Slider
            bind:value={() => session.volume, (v) => session.setVolume(v)}
            min={0}
            max={1}
            step={0.01}
            defaultValue={1}
            fillFrom={0}
            label="Volume"
          />
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Base-colored bar with a whisper of sheen from the bottom edge. */
  .transport {
    background:
      linear-gradient(0deg, rgba(255, 255, 255, 0.025), transparent),
      var(--bg);
  }

  .play-btn {
    background: linear-gradient(
      160deg,
      var(--accent-hover),
      var(--accent) 60%,
      #cf922e
    );
    /* First ring is the page/bar color, so where the disc rides up over content
       it stays cleanly separated; then the amber glow and top sheen. */
    box-shadow:
      0 0 0 4px var(--bg),
      0 4px 16px rgba(229, 168, 62, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.35);
  }
</style>
