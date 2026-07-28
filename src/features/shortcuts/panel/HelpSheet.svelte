<script lang="ts">
  import IconButton from '@/ui/shared/IconButton.svelte';
  import { comboChips } from '@/ui/shared/hotkey';
  import { ACTION_LABELS } from '@/core/model/defaults';
  import type { ActionId } from '@/core/model/types';
  import { settings } from '@/features/settings/panel/settings.svelte';
  import { CAN_CAPTURE_TAB } from '@/core/platform';
  import { view } from '@/core/state/view.svelte';

  const actionIds = Object.keys(ACTION_LABELS) as ActionId[];
</script>

<div class="sheet" role="dialog" aria-label="Help">
  <header>
    <h1>Help</h1>
    <IconButton icon="close" label="Close help" onclick={() => view.close()} />
  </header>

  <section>
    <h2>Getting started</h2>
    <ul>
      <li>Play audio or video on any page and Note by Note connects automatically.</li>
      <li>To practice with your own files, use Settings → Play local file.</li>
    </ul>
  </section>

  <section>
    <h2>Sound controls</h2>
    <ul>
      <li><strong>Transpose</strong> shifts the key in semitones.</li>
      <li><strong>Pitch</strong> fine-tunes in cents or Hz.</li>
      <li>
        <strong>Speed</strong> plays slower or faster (25–200%) without
        changing the pitch.
      </li>
      <li><strong>Vocal Reducer</strong> lowers the vocals to play or sing along.</li>
      <li>
        <strong>Equalizer</strong> shapes the sound with a 10-band EQ. Presets
        bring out one instrument.
      </li>
    </ul>
  </section>

  <section>
    <h2>Loops, markers &amp; snippets</h2>
    <ul>
      <li><strong>Marker</strong> drops a marker at the current position.</li>
      <li>
        <strong>Click a marker</strong> loops the section from it to the next
        marker.
      </li>
      <li>
        <strong>Drag across markers</strong>, or click one then
        <kbd>Shift</kbd> + click another, to loop every section between them.
      </li>
      <li><strong>Loop</strong> toggles the selected range on and off.</li>
      <li><strong>Repeat song</strong> loops the whole track.</li>
      <li><strong>Count-in</strong> adds a short pause before each loop restart.</li>
      <li>
        <strong>Snippets</strong> save the selected range so you can jump back to
        it anytime.
      </li>
    </ul>
  </section>

  <section>
    <h2>Connection modes</h2>
    <ul>
      <li>
        <strong>Direct</strong> controls the page's player. All features work.
      </li>
      {#if CAN_CAPTURE_TAB}
        <li>
          <strong>Hybrid</strong> runs playback through the page's player and
          pitch processing through tab audio.
        </li>
        <li>
          <strong>Tab audio</strong> processes all audio from the tab. Used when
          direct access is blocked; pitch shift only.
        </li>
      {/if}
      <li>
        <strong>Local file</strong> plays a file opened from Settings. All
        features work.
      </li>
    </ul>
  </section>

  <section>
    <h2>Keyboard shortcuts</h2>
    <table>
      <tbody>
        {#each actionIds as actionId (actionId)}
          <tr>
            <td>{ACTION_LABELS[actionId]}</td>
            <td class="key">
              {#each comboChips(settings.current.keymap[actionId]) as chip, i (i)}
                <kbd>{chip}</kbd>
              {/each}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="hint">
      Shortcuts work while the side panel is focused. Remap them in
      Settings → Keyboard.
    </p>
  </section>

  <section>
    <h2>Troubleshooting</h2>
    <ol>
      <li>Start playback on the page. Note by Note connects once media is playing.</li>
      <li>Still not connected? Reload the page, then reopen the extension.</li>
      {#if CAN_CAPTURE_TAB}
        <li>On protected sites, enable tab audio (Settings → Tab audio) to keep pitch shifting.</li>
      {:else}
        <li>
          On protected sites the audio processor stays blocked — open the file from
          Settings → Play a local file to get pitch shifting back.
        </li>
      {/if}
      <li>Other audio or video extensions can conflict, so try disabling them.</li>
    </ol>
  </section>

</div>

<style>
  .sheet {
    position: absolute;
    inset: 0;
    background: var(--bg);
    padding: 14px;
    overflow-y: auto;
    z-index: 20;
  }

  header {
    display: flex;
    align-items: center;
    margin-bottom: 10px;
  }

  h1 {
    flex: 1;
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    text-align: center;
    /* Balance the close button so the title stays centered. */
    padding-left: 30px;
  }

  section {
    margin-bottom: 16px;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  ul,
  ol {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  li strong {
    color: var(--text);
    font-weight: 600;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  td {
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }

  .key {
    text-align: right;
    white-space: nowrap;
  }

  kbd {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    background: var(--bg-inset);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    white-space: nowrap;
  }

  /* Modifier and key sit as separate chips (⇧ ←), so they need a gap. */
  kbd + kbd {
    margin-left: 3px;
  }

  .hint {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--text-faint);
  }
</style>
