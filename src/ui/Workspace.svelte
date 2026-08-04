<script lang="ts">
  import { fade } from 'svelte/transition';
  import { formatClock } from '@/core/model/format';
  import ConnectionBanner from './chrome/ConnectionBanner.svelte';
  import HeaderBar from './chrome/HeaderBar.svelte';
  import TransportBar from './chrome/TransportBar.svelte';
  import Section from './Section.svelte';
  import SnippetsSection from '../features/snippets/panel/SnippetsSection.svelte';
  import MarkerChips from '../features/markers/panel/MarkerChips.svelte';
  import MarkerToolbar from '../features/markers/panel/MarkerToolbar.svelte';
  import PanelStack from './panels/PanelStack.svelte';
  import ChordStrip from '../features/chords/panel/ChordStrip.svelte';
  import IconButton from './shared/IconButton.svelte';
  import { uiPrefs } from '@/features/settings/panel/settings.svelte';
  import Timeline from './timeline/Timeline.svelte';
  import { timelineDrag } from './timeline/timeline-drag.svelte';
  import { timelineView } from './timeline/timeline-view.svelte';

  let {
    onconnect,
    oncapture,
  }: {
    onconnect?: () => void;
    oncapture?: () => void;
  } = $props();
</script>

<div class="flex flex-col h-full">
  <HeaderBar />
  <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
    <ConnectionBanner {onconnect} {oncapture} />
    <PanelStack />
    <Section id="looper" label="Looper">
      {#snippet header()}
        {#if timelineDrag.active}
          <!-- Centered over the whole title row, independent of the flex
               children, and non-interactive so it never intercepts clicks. -->
          <div
            class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1.25 text-[11px] text-muted whitespace-nowrap pointer-events-none select-none"
            transition:fade={{ duration: 150 }}
          >
            Hold <kbd
              class="font-mono text-[10px] leading-none text-fg bg-inset border border-line-strong rounded-sm px-1.25 py-0.5 whitespace-nowrap"
            >Shift</kbd> to fine-tune
          </div>
        {:else if timelineView.hintVisible}
          <!-- Same slot: which slice of the track the zoomed timeline is showing.
               Flashed on each zoom/pan rather than pinned, so it reads like a
               volume OSD instead of squatting on the section title. Ranks above
               the hover hint because zooming happens with the pointer over the
               bar, which is exactly when that hint is also showing. -->
          <div
            class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1.25 text-[11px] text-muted font-mono whitespace-nowrap pointer-events-none select-none"
            transition:fade={{ duration: 150 }}
          >
            {formatClock(timelineView.start)} – {formatClock(timelineView.end)}
          </div>
        {:else if timelineDrag.hoverHint}
          <!-- Same centered slot: what the hovered pin does, or the wheel
               gestures the bar itself accepts. -->
          <div
            class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1.25 text-[11px] text-muted whitespace-nowrap pointer-events-none select-none"
            transition:fade={{ duration: 150 }}
          >
            {timelineDrag.hoverHint}
          </div>
        {/if}
      {/snippet}
      <div class="surface flex flex-col gap-3 p-3.5">
        <!-- Timeline view controls, at the top-right of the card, directly above
             the bar they act on. Zoom is also on Ctrl/Cmd+wheel and the z
             hotkeys, but those are invisible — without buttons there is nothing
             to tell you the timeline zooms at all. At full-track view the row
             collapses to the one button that does anything there, zoom in; at
             the narrowest window zoom in greys out as the far end. -->
        <!-- Negative margins cancel the card's gap-3 on both sides: the row is
             chrome for the bar right below it, so it sits tight against it
             rather than reading as a third stacked control. -->
        <div class="flex items-center justify-end gap-0.5 -mt-1 -mb-3">
          <!-- All three are no-ops at full-track view — nothing to fit back to,
               following is trivially satisfied, and there is no zooming out
               left — so they start absent and grey out on the way back instead
               of vanishing again: a row that keeps rearranging itself is harder
               to aim at than one carrying a few dead buttons. Right-aligned, so
               their first appearance grows the cluster leftwards and zoom in
               never shifts. -->
          {#if timelineView.everZoomed}
            <IconButton
              icon="reset"
              label="Zoom to fit whole track"
              action="zoomFit"
              disabled={timelineView.atFit}
              onclick={() => timelineView.zoomToFit()}
            />
            <IconButton
              icon="follow"
              label="Auto-follow playhead"
              active={uiPrefs.current.timelineFollow}
              disabled={timelineView.atFit}
              onclick={() => uiPrefs.setTimelineFollow(!uiPrefs.current.timelineFollow)}
            />
            <IconButton
              icon="zoomOut"
              label="Zoom out"
              action="zoomOut"
              disabled={timelineView.atFit}
              onclick={() => timelineView.zoomStep(-1)}
            />
          {/if}
          <IconButton
            icon="zoomIn"
            label="Zoom in"
            action="zoomIn"
            disabled={timelineView.atMaxZoom}
            onclick={() => timelineView.zoomStep(1)}
          />
        </div>
        <Timeline />
        <MarkerToolbar />
        <MarkerChips />
      </div>
    </Section>
    <SnippetsSection />
    <ChordStrip />
  </div>
  <TransportBar />
</div>
