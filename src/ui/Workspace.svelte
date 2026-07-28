<script lang="ts">
  import { fade } from 'svelte/transition';
  import ConnectionBanner from './chrome/ConnectionBanner.svelte';
  import HeaderBar from './chrome/HeaderBar.svelte';
  import TransportBar from './chrome/TransportBar.svelte';
  import Section from './Section.svelte';
  import SnippetsSection from '../features/snippets/panel/SnippetsSection.svelte';
  import MarkerChips from '../features/markers/panel/MarkerChips.svelte';
  import MarkerToolbar from '../features/markers/panel/MarkerToolbar.svelte';
  import PanelStack from './panels/PanelStack.svelte';
  import ChordStrip from '../features/chords/panel/ChordStrip.svelte';
  import Timeline from './timeline/Timeline.svelte';
  import { timelineDrag } from './timeline/timeline-drag.svelte';

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
        {:else if timelineDrag.hoverHint}
          <!-- Same centered slot: what the hovered pin does. -->
          <div
            class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1.25 text-[11px] text-muted whitespace-nowrap pointer-events-none select-none"
            transition:fade={{ duration: 150 }}
          >
            {timelineDrag.hoverHint}
          </div>
        {/if}
      {/snippet}
      <div class="surface flex flex-col gap-3 p-3.5">
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
