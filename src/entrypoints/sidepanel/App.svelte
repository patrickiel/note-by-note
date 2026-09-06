<script lang="ts">
  import Workspace from '@/ui/Workspace.svelte';
  import CountInOverlay from '@/features/count-in/panel/CountInOverlay.svelte';
  import HelpSheet from '@/features/shortcuts/panel/HelpSheet.svelte';
  import LibraryView from '@/features/library/panel/LibraryView.svelte';
  import SettingsView from '@/features/settings/panel/SettingsView.svelte';
  import TooltipLayer from '@/ui/shared/TooltipLayer.svelte';
  import { sendMessage } from '@/core/messaging/rpc';
  import { openTabWithPanel } from '@/core/side-panel';
  import { installMockState, installMockTicker } from '@/dev/mock';
  import { connection } from '@/core/state/connect.svelte';
  import { CAN_CAPTURE_TAB } from '@/core/platform';
  import { features } from '@/core/features';
  import { session } from '@/core/state/session.svelte';
  import { applyTheme, settings } from '@/features/settings/panel/settings.svelte';
  import { installShortcuts } from '@/features/shortcuts/panel/shortcuts';
  import { trackSync } from '@/core/state/track-sync.svelte';
  import { view } from '@/core/state/view.svelte';
  import { sync } from '@/features/sync/panel/sync.svelte';

  const params = new URLSearchParams(location.search);
  const mock = params.has('mock');
  // ?mock=1&play=1 also runs the playhead, for previewing time-driven UI.
  const mockPlay = mock && params.has('play');
  // Each panel feature loads its own storage concurrently (see core/features.ts).
  const ready = Promise.all(features.map((f) => f.init?.())).then(
    async () => {
      applyTheme(settings.current.theme);
      trackSync.init();
      session.onMediaEvent = (media) => {
        trackSync.onMedia(media).catch((err: unknown) => {
          console.error('[note-by-note] track sync failed', err);
        });
      };
      // Applying another device's changes reloads this document, so a merge
      // that arrived mid-practice waits for the track to go away.
      session.onMediaChanged = (media) => sync.onMedia(media);
      session.onUserParamsChange = () => trackSync.onParamsChanged();
      session.onEngineDetached = () => trackSync.onEngineLost();
      // Diagnostics for the E2E harness; kept out of release builds.
      if (import.meta.env.DEV || import.meta.env.MODE === 'testing') {
        (globalThis as Record<string, unknown>).__panelDebug = {
          media: () => $state.snapshot(session.media),
          connection: () => session.connection,
          capturing: () => session.capturing,
          lastError: () => $state.snapshot(session.lastError),
        };
      }
      installShortcuts();
      // Fire-and-forget: opening the panel must not wait on the network.
      void sync.init();
      if (mock) {
        installMockState();
        if (mockPlay) installMockTicker();
      } else await connection.init();
    },
  );

  // Opened from here rather than via the background: the side panel has to
  // follow the user to the player tab, and only this document holds the
  // click's activation that `sidePanel.open()` requires.
  async function openLocalFile() {
    await openTabWithPanel(browser.runtime.getURL('/local-player.html'));
    view.close();
  }

  async function revokePermissions() {
    await sendMessage('revokeAllPermissions', undefined);
  }

  function toggleTabAudio(on: boolean) {
    if (on) void connection.startCapture();
    else void connection.stopCapture();
  }
</script>

{#await ready then}
  <div class="relative h-full overflow-hidden">
    <!-- Where tab capture doesn't exist (Firefox), the handlers are left off
         rather than made to fail: an absent `oncapture`/`ontabaudio` is what
         tells the shared UI to drop the affordance and reword around it. -->
    <Workspace
      onconnect={() => connection.requestAndConnect()}
      oncapture={CAN_CAPTURE_TAB ? () => connection.startCapture() : undefined}
    />
    {#if view.current === 'settings'}
      <SettingsView
        onlocalfile={openLocalFile}
        ontabaudio={CAN_CAPTURE_TAB ? toggleTabAudio : undefined}
        onrevoke={revokePermissions}
      />
    {:else if view.current === 'library'}
      <LibraryView
        onopen={(entry) => {
          void trackSync.openHistoryEntry(connection.tabId, entry);
          view.close();
        }}
      />
    {:else if view.current === 'help'}
      <HelpSheet />
    {/if}
    <CountInOverlay />
    <!-- Last child, fixed-positioned: one bubble that outranks every sheet. -->
    <TooltipLayer />
  </div>
{/await}
