<script lang="ts">
  import type { Component } from 'svelte';
  import { PANEL_ORDER } from '@/core/model/defaults';
  import type { PanelId } from '@/core/model/types';
  import { uiPrefs } from '@/features/settings/panel/settings.svelte';
  import Section from '@/ui/Section.svelte';
  import EqualizerPanel from '../../features/eq/panel/EqualizerPanel.svelte';
  import PitchPanel from '../../features/pitch/panel/PitchPanel.svelte';
  import SpeedPanel from '../../features/speed/panel/SpeedPanel.svelte';
  import TransposePanel from '../../features/pitch/panel/TransposePanel.svelte';
  import VocalReducerPanel from '../../features/vocal-reducer/panel/VocalReducerPanel.svelte';

  /** The pitch/time trio shares one card, split by separators. */
  const PLAYBACK_GROUP: Partial<Record<PanelId, Component<{ grouped?: boolean }>>> = {
    transpose: TransposePanel,
    pitch: PitchPanel,
    speed: SpeedPanel,
  };

  /** Effects share one card, split by separators. */
  const EFFECTS_GROUP: Partial<Record<PanelId, Component<{ grouped?: boolean }>>> = {
    vocalReducer: VocalReducerPanel,
    equalizer: EqualizerPanel,
  };

  let playbackIds = $derived(PANEL_ORDER.filter((id) => id in PLAYBACK_GROUP));
  let effectsIds = $derived(PANEL_ORDER.filter((id) => id in EFFECTS_GROUP));

  // Side-by-side only reads well when both sections are expanded; a collapsed
  // section leaves a lone header floating next to a full one. Stack instead.
  let eitherCollapsed = $derived(
    uiPrefs.current.collapsedSections.playback ||
      uiPrefs.current.collapsedSections.effects,
  );
</script>

<div class="stack-container">
  <div class={['stack', { 'stack--stacked': eitherCollapsed }]}>
    <!-- The wrapper owns the wide-layout flex share (`.stack-col` is scoped
         to this template; Section's root element wouldn't inherit it).
         Not named `.panel-section`: Firefox's legacy browser_style sheet
         defines that class as a flex row. -->
    <div class="stack-col">
      <Section id="playback" label="Playback">
        <div class="group surface">
          {#each playbackIds as id (id)}
            {@const PanelComponent = PLAYBACK_GROUP[id]!}
            <PanelComponent grouped />
          {/each}
        </div>
      </Section>
    </div>
    <div class="stack-col">
      <Section id="effects" label="Effects">
        <div class="group surface">
          {#each effectsIds as id (id)}
            {@const PanelComponent = EFFECTS_GROUP[id]!}
            <PanelComponent grouped />
          {/each}
        </div>
      </Section>
    </div>
  </div>
</div>

<style>
  .stack-container {
    container-type: inline-size;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Wide sidebar: lay the two sections side by side, sharing the width equally. */
  @container (min-width: 680px) {
    .stack:not(.stack--stacked) {
      flex-direction: row;
      align-items: start;
    }

    .stack:not(.stack--stacked) .stack-col {
      flex: 1 1 0;
      min-width: 0;
    }
  }

  .group > :global(.panel + .panel) {
    border-top: 1px solid var(--border);
  }
</style>
