<script lang="ts">
  import Dropdown from '@/ui/shared/Dropdown.svelte';
  import Icon from '@/ui/shared/Icon.svelte';
  import IconButton from '@/ui/shared/IconButton.svelte';
  import SegmentedControl from '@/ui/shared/SegmentedControl.svelte';
  import Toggle from '@/ui/shared/Toggle.svelte';
  import { tooltip } from '@/ui/shared/tooltip.svelte';
  import {
    SCRUB_PREVIEW_OPTIONS,
    SEEK_INTERVALS,
    TRANSPOSE_RANGE_STANDARD,
  } from '@/core/model/defaults';
  import type { PitchDisplay, Theme } from '@/core/model/types';
  import type { IconName } from '@/ui/icons';
  import {
    backupFilename,
    createBackup,
    parseBackup,
    restoreBackup,
  } from '@/core/persist/backup';
  import { encodeBackup } from '@/core/persist/backup-codec';
  import { history } from '@/features/library/panel/history.svelte';
  import { applyTheme, settings } from '@/features/settings/panel/settings.svelte';
  import { session } from '@/core/state/session.svelte';
  import { view } from '@/core/state/view.svelte';
  import { sync } from '@/features/sync/panel/sync.svelte';
  import { cubicOut } from 'svelte/easing';
  import { slide } from 'svelte/transition';
  import KeymapEditor from '../../shortcuts/panel/KeymapEditor.svelte';

  // Read from the manifest rather than a literal, which drifts from
  // package.json (WXT copies the version across at build time).
  const version = browser.runtime.getManifest().version;

  let {
    onlocalfile,
    ontabaudio,
    onrevoke,
  }: {
    onlocalfile?: () => void;
    ontabaudio?: (on: boolean) => void;
    onrevoke?: () => void;
  } = $props();

  let mappingsOpen = $state(false);
  let fileInput: HTMLInputElement;
  let busy = $state(false);
  let notice = $state<{ ok: boolean; text: string } | null>(null);

  /** UI-level view of the `autoReset` / `rememberSettings` pair, which the
   * settings store keeps mutually exclusive. Both off = carry over. */
  type NewSongBehavior = 'defaults' | 'keep' | 'lastUsed';

  const themeOptions: { value: Theme; label: string; icon: IconName }[] = [
    { value: 'auto', label: 'Auto', icon: 'themeAuto' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
  ];
  const pitchOptions: { value: PitchDisplay; label: string }[] = [
    { value: 'cents', label: 'Cents' },
    { value: 'hz', label: 'Hz' },
  ];
  const newSongOptions: { value: NewSongBehavior; label: string }[] = [
    { value: 'defaults', label: 'Defaults' },
    { value: 'keep', label: 'Keep' },
    { value: 'lastUsed', label: 'Last used' },
  ];
  const seekOptions = SEEK_INTERVALS.map((s) => ({ value: s, label: `${s} s` }));
  const scrubOptions = SCRUB_PREVIEW_OPTIONS.map((ms) => ({
    value: ms,
    label: `${ms} ms`,
  }));
  const countInBeatOptions = [1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: `${n}` }));
  const countInBpmOptions = [60, 70, 80, 90, 100, 110, 120, 130, 140, 160, 180].map(
    (n) => ({ value: n, label: `${n} BPM` }),
  );

  let newSongBehavior = $derived<NewSongBehavior>(
    settings.current.autoReset
      ? 'defaults'
      : settings.current.rememberSettings
        ? 'lastUsed'
        : 'keep',
  );

  function setNewSongBehavior(value: NewSongBehavior) {
    void settings.update({
      autoReset: value === 'defaults',
      rememberSettings: value === 'lastUsed',
    });
  }

  function setTheme(value: Theme) {
    void settings.update({ theme: value });
    applyTheme(value);
  }

  function setTabAudio(on: boolean) {
    void settings.update({ tabAudio: on });
    ontabaudio?.(on);
  }

  /** Turning the extended range off pulls any out-of-range transpose back into
   * ±12 so the control and the audio can't disagree. */
  function setExtendedTranspose(on: boolean) {
    void settings.update({ extendedTranspose: on });
    if (on) return;
    const t = session.params.transpose;
    const clamped = Math.max(-TRANSPOSE_RANGE_STANDARD, Math.min(TRANSPOSE_RANGE_STANDARD, t));
    if (clamped !== t) session.patchParams({ transpose: clamped });
  }

  function clearHistoryConfirmed() {
    if (confirm('Remove all saved songs from the history list?')) {
      void history.clear();
    }
  }

  function resetSettingsConfirmed() {
    if (!confirm('Restore all extension settings to their defaults?')) return;
    void settings.reset();
    applyTheme('auto');
  }

  function revokeConfirmed() {
    if (confirm('Remove access for all websites you have previously granted?')) {
      onrevoke?.();
    }
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function exportData() {
    busy = true;
    notice = null;
    try {
      const backup = await createBackup();
      // The compact form — a fraction of the verbose one and the shape that
      // will ride the browser's sync storage; import reads both.
      const text = JSON.stringify(encodeBackup(backup));
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFilename(backup.exportedAt);
      link.click();
      // The download reads the blob after click() returns, so the URL has to
      // outlive this task.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      const songs = backup.history.length + backup.favorites.length;
      const kb = Math.max(1, Math.round(new TextEncoder().encode(text).length / 1024));
      notice = { ok: true, text: `Saved ${link.download} (${songs} songs, ${kb} KB).` };
    } catch (err) {
      notice = { ok: false, text: `Export failed: ${message(err)}` };
    } finally {
      busy = false;
    }
  }

  /** Validates before asking, so a wrong file can't reach the scary prompt. */
  async function importData(file: File) {
    busy = true;
    notice = null;
    try {
      const backup = parseBackup(await file.text());
      const ok = confirm(
        'Replace all settings, history, favorites, presets, markers and snippets ' +
          'with the contents of this file? Your current data is lost.',
      );
      if (!ok) return;
      await restoreBackup(backup, { asNew: true });
      // Every store reads storage once at start-up; a reload is the honest way
      // to get the whole panel — theme, open track, engine — onto new data.
      location.reload();
    } catch (err) {
      notice = { ok: false, text: `Import failed: ${message(err)}` };
    } finally {
      busy = false;
    }
  }

  function onFilePicked(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    // Cleared so picking the same file twice still fires a change event.
    event.currentTarget.value = '';
    if (file) void importData(file);
  }

  let syncBusy = $state(false);
  let syncNotice = $state<{ ok: boolean; text: string } | null>(null);

  async function setSyncEnabled(on: boolean) {
    syncBusy = true;
    syncNotice = null;
    try {
      if (on) await sync.enable();
      else await sync.disable();
    } finally {
      syncBusy = false;
    }
  }

  async function deleteSyncedData() {
    const ok = confirm(
      "Delete the copy of your data in the browser's sync storage? Sync will be " +
        'turned off on this device. Data on this device is not affected, and other ' +
        'devices with sync on will upload their copy again.',
    );
    if (!ok) return;
    syncBusy = true;
    syncNotice = null;
    try {
      await sync.deleteRemote();
      syncNotice = { ok: true, text: 'Synced data deleted.' };
    } catch (err) {
      syncNotice = { ok: false, text: `Delete failed: ${message(err)}` };
    } finally {
      syncBusy = false;
    }
  }

  function lastSynced(ts: number): string {
    if (!ts) return 'never';
    const minutes = Math.round((Date.now() - ts) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(ts).toLocaleDateString();
  }
</script>

{#snippet actionText(title: string, desc: string)}
  <span class="flex-1 min-w-0 flex flex-col gap-px">
    <span class="text-[13px] font-semibold text-fg">{title}</span>
    <span class="text-[12px] text-muted">{desc}</span>
  </span>
{/snippet}

{#snippet prefText(label: string, desc = '')}
  <span class="flex-1 min-w-0 flex flex-col gap-0.5">
    <span class="text-[13px] font-semibold">{label}</span>
    {#if desc}
      <span class="text-[12px] text-muted">{desc}</span>
    {/if}
  </span>
{/snippet}

<section class="absolute inset-0 z-20 bg-base overflow-y-auto" aria-label="Settings">
  <header
    class="sticky top-0 z-2 flex items-center justify-center py-2.5 px-11 bg-base border-b border-line"
  >
    <h1 class="m-0 text-[15px] font-bold">Settings</h1>
    <div class="absolute right-2 top-1/2 -translate-y-1/2">
      <IconButton icon="close" label="Close settings" size={20} onclick={() => view.close()} />
    </div>
  </header>

  <div class="flex flex-col gap-2.5 pt-2.5 px-2 pb-4">
    <!-- Where the sound comes from -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Audio source</h2>
      <button
        type="button"
        class="flex items-center gap-3 w-full text-left py-2.5 px-3 hover:bg-hover"
        onclick={() => onlocalfile?.()}
      >
        <span
          class="flex-none flex items-center justify-center size-8.5 rounded-full text-accent-ink bg-accent-soft"
        >
          <Icon name="playCircle" size={20} />
        </span>
        {@render actionText(
          'Play a local file',
          'Open an audio or video file from your device.',
        )}
      </button>

      <!-- Omitted where the browser has no tab capture (Firefox): the stored
           `tabAudio` preference can still arrive from a synced Chrome profile,
           so the handler — not the setting — decides whether to show this. -->
      {#if ontabaudio}
        <div
          class="flex items-center gap-3 w-full text-left cursor-default py-2.5 px-3 border-t border-line"
        >
          <span
            class="flex-none flex items-center justify-center size-8.5 rounded-full text-accent-ink bg-accent-soft"
          >
            <Icon name="tabAudio" size={20} />
          </span>
          {@render actionText(
            'Capture tab audio',
            "Take the sound straight from the tab when its own player can't be used. Pitch shifting only.",
          )}
          <Toggle
            checked={settings.current.tabAudio}
            label="Capture tab audio"
            onchange={setTabAudio}
          />
        </div>
      {/if}
    </div>

    <!-- Look and units -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Appearance</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        {@render prefText('Theme', 'Follow your system, or force light or dark.')}
        <SegmentedControl
          options={themeOptions}
          value={settings.current.theme}
          onchange={setTheme}
        />
      </div>
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        {@render prefText('Pitch units', 'Show fine pitch changes in cents or in hertz.')}
        <SegmentedControl
          options={pitchOptions}
          value={settings.current.pitchDisplay}
          onchange={(v) => void settings.update({ pitchDisplay: v })}
        />
      </div>
    </div>

    <!-- What happens across songs -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Songs &amp; history</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        {@render prefText(
          'Save songs automatically',
          'Add every song you play to the Recent list, with its settings.',
        )}
        <Toggle
          checked={settings.current.autoSave}
          label="Save songs automatically"
          onchange={(on) => void settings.update({ autoSave: on })}
        />
      </div>
      <div class="flex flex-col items-start gap-2 py-2.5 px-3 border-t border-line">
        {@render prefText(
          'When you open a new song',
          'What happens to transpose, pitch and speed on a song with nothing saved yet: start from the defaults, keep what is set right now, or reuse the settings from your last song. Songs in Recent or Favorites always come back with their own settings, however you open them.',
        )}
        <SegmentedControl
          options={newSongOptions}
          value={newSongBehavior}
          onchange={setNewSongBehavior}
        />
      </div>
    </div>

    <!-- Input and transport -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Controls</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        {@render prefText('Skip amount', 'How far the skip buttons jump forward or back.')}
        <Dropdown
          options={seekOptions}
          value={settings.current.seekInterval}
          label="Skip amount in seconds"
          onchange={(v) => void settings.update({ seekInterval: v })}
        />
      </div>
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        {@render prefText(
          'Timeline preview',
          'How much audio you hear when you click or drag on the timeline.',
        )}
        <Dropdown
          options={scrubOptions}
          value={settings.current.scrubPreviewMs}
          label="Timeline preview length in milliseconds"
          onchange={(v) => void settings.update({ scrubPreviewMs: v })}
        />
      </div>
    </div>

    <!-- Count-in before playback -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Count-in</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        {@render prefText('Beats', 'How many beats to count before playback resumes.')}
        <Dropdown
          options={countInBeatOptions}
          value={settings.current.countInBeats}
          label="Count-in beats"
          onchange={(v) => void settings.update({ countInBeats: v })}
        />
      </div>
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        {@render prefText(
          'Tempo',
          'Count-in beats per minute. A song tempo set in the Speed panel overrides this.',
        )}
        <Dropdown
          options={countInBpmOptions}
          value={settings.current.countInBpm}
          label="Count-in tempo in BPM"
          onchange={(v) => void settings.update({ countInBpm: v })}
        />
      </div>
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        {@render prefText(
          'Play beeps',
          'Click on each beat, accenting the first. Direct connections only.',
        )}
        <Toggle
          checked={settings.current.countInBeep}
          label="Play count-in beeps"
          onchange={(on) => void settings.update({ countInBeep: on })}
        />
      </div>
    </div>

    <!-- Effect behaviour -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Effects</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        {@render prefText(
          'Extended transpose range',
          'Let the Transpose control reach ±36 semitones (three octaves) instead of the usual ±12.',
        )}
        <Toggle
          checked={settings.current.extendedTranspose}
          label="Extended transpose range"
          onchange={setExtendedTranspose}
        />
      </div>
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        {@render prefText(
          'Low latency',
          'Reduces the processing delay through the pitch engine, keeping audio more in sync, with a slight drop in audio quality.',
        )}
        <Toggle
          checked={settings.current.lowLatency}
          label="Low latency"
          onchange={(on) => void settings.update({ lowLatency: on })}
        />
      </div>
    </div>

    <!-- Keyboard -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Keyboard shortcuts</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        {@render prefText(
          'Use keyboard shortcuts',
          'Control playback with the keyboard while the side panel is focused.',
        )}
        <Toggle
          checked={settings.current.shortcutsEnabled}
          label="Use keyboard shortcuts"
          onchange={(on) => void settings.update({ shortcutsEnabled: on })}
        />
      </div>
      {#if settings.current.shortcutsEnabled}
        <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
          {@render prefText('Use my own keys', 'Replace the default keys with your own.')}
          <Toggle
            checked={settings.current.customShortcuts}
            label="Use my own keys"
            onchange={(on) => void settings.update({ customShortcuts: on })}
          />
        </div>
        <button
          type="button"
          class="flex items-center gap-2.5 w-full text-left text-fg py-2.5 px-3 border-t border-line hover:bg-hover"
          aria-expanded={mappingsOpen}
          onclick={() => (mappingsOpen = !mappingsOpen)}
        >
          <span class="flex text-muted"><Icon name="keyboard" size={18} /></span>
          <span class="flex-1 min-w-0 text-[13px] font-semibold">
            {settings.current.customShortcuts ? 'Edit shortcuts' : 'All shortcuts'}
          </span>
          <span
            class={[
              'flex text-muted transition-transform duration-180 ease-out',
              mappingsOpen && 'rotate-180',
            ]}
          >
            <Icon name="chevronDown" size={16} />
          </span>
        </button>
        {#if mappingsOpen}
          <div class="px-3 pb-2.5 pt-0" transition:slide={{ duration: 180, easing: cubicOut }}>
            <KeymapEditor enabled={settings.current.customShortcuts} />
          </div>
        {/if}
      {/if}
    </div>

    <!-- Cross-device sync -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Sync</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        {@render prefText(
          'Sync between devices',
          "Keep your settings, songs, presets, markers and snippets the same everywhere. Uses your browser's built-in sync: sign in to the browser with sync turned on and it reaches your other devices. No account with us, no server.",
        )}
        <Toggle
          bind:checked={() => sync.enabled, (on) => void setSyncEnabled(on)}
          label="Sync between devices"
        />
      </div>
      {#if sync.enabled}
        {#if sync.pendingApply}
          <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
            {@render prefText(
              'Changes from another device are waiting',
              'They are applied when no song is loaded, or now — applying reloads the panel.',
            )}
            <button
              type="button"
              class="flex-none py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
              disabled={syncBusy || sync.status === 'syncing'}
              onclick={() => void sync.syncNow()}
              {@attach tooltip('Apply the changes now')}
            >
              Apply
            </button>
          </div>
        {/if}
        {#if sync.trimmed}
          <div class="text-[12px] text-muted py-2.5 px-3 border-t border-line">
            The browser's sync storage is full, so the oldest songs and chord charts stay
            on this device only. Everything else syncs.
          </div>
        {/if}
        <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
          <span
            class={[
              'flex-1 min-w-0 text-[12px]',
              sync.status === 'error' ? 'text-danger' : 'text-muted',
            ]}
          >
            {#if sync.status === 'syncing'}
              Syncing…
            {:else if sync.status === 'error'}
              {sync.lastError}
            {:else if sync.lastSyncedAt}
              Last synced {lastSynced(sync.lastSyncedAt)} · {sync.usedPercent}% of 100 KB used
            {:else}
              Nothing synced yet
            {/if}
          </span>
          <button
            type="button"
            class="flex-none py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
            disabled={syncBusy || sync.status === 'syncing'}
            onclick={() => void sync.syncNow()}
            {@attach tooltip('Back up now and pull in changes from your other devices')}
          >
            Sync now
          </button>
        </div>
        <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
          {@render prefText(
            'Delete synced data',
            "Empties the copy in the browser's sync storage and turns sync off here. Data on this device is kept.",
          )}
          <button
            type="button"
            class="flex-none py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
            disabled={syncBusy || sync.status === 'syncing'}
            onclick={() => void deleteSyncedData()}
            {@attach tooltip('Delete the synced copy')}
          >
            Delete
          </button>
        </div>
      {/if}
      {#if syncNotice}
        <div
          class={[
            'text-[12px] py-2.5 px-3 border-t border-line',
            syncNotice.ok ? 'text-muted' : 'text-danger',
          ]}
        >
          {syncNotice.text}
        </div>
      {/if}
    </div>

    <!-- Destructive actions, last -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">Data &amp; reset</h2>
      <div class="flex items-center gap-3 py-2.5 px-3">
        <span class="flex-none flex justify-center w-6 text-muted"
          ><Icon name="download" size={18} /></span
        >
        {@render prefText('Backup file', 'Export or import all your data. Rarely needed with sync on.')}
        <div class="flex-none flex items-center gap-1">
          <button
            type="button"
            class="py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
            disabled={busy}
            onclick={exportData}
            {@attach tooltip('Export everything to a file')}
          >
            Export
          </button>
          <button
            type="button"
            class="py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
            disabled={busy}
            onclick={() => fileInput.click()}
            {@attach tooltip('Import a backup, replacing everything on this device')}
          >
            Import
          </button>
          <input
            bind:this={fileInput}
            class="hidden"
            type="file"
            accept="application/json,.json"
            tabindex="-1"
            aria-hidden="true"
            onchange={onFilePicked}
          />
        </div>
      </div>
      {#if notice}
        <div
          class={[
            'text-[12px] py-2.5 px-3 border-t border-line',
            notice.ok ? 'text-muted' : 'text-danger',
          ]}
        >
          {notice.text}
        </div>
      {/if}
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        <span class="flex-none flex justify-center w-6 text-muted"
          ><Icon name="clearAll" size={18} /></span
        >
        {@render prefText('Clear history', 'Remove all saved songs from the Recent list.')}
        <button
          type="button"
          class="flex-none py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
          onclick={clearHistoryConfirmed}
          {@attach tooltip('Remove every saved song from Recent')}
        >
          Clear
        </button>
      </div>
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        <span class="flex-none flex justify-center w-6 text-muted"
          ><Icon name="restore" size={18} /></span
        >
        {@render prefText('Reset settings', 'Put every setting on this page back to its default.')}
        <button
          type="button"
          class="flex-none py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
          onclick={resetSettingsConfirmed}
          {@attach tooltip('Put every setting on this page back to its default')}
        >
          Reset
        </button>
      </div>
      <div class="flex items-center gap-3 py-2.5 px-3 border-t border-line">
        <span class="flex-none flex justify-center w-6 text-muted"
          ><Icon name="shield" size={18} /></span
        >
        {@render prefText(
          'Revoke website access',
          'Take back the access you granted to every website.',
        )}
        <button
          type="button"
          class="flex-none py-1 px-2 text-[13px] font-bold text-accent-ink rounded-sm hover:not-disabled:bg-accent-soft disabled:opacity-40 disabled:cursor-default"
          onclick={revokeConfirmed}
          {@attach tooltip('Take back the access you granted to every website')}
        >
          Revoke
        </button>
      </div>
    </div>

    <!-- Support -->
    <div class="surface overflow-hidden">
      <h2 class="m-0 pt-3 px-3 pb-1 text-[13.5px] font-bold">About &amp; support</h2>
      <a
        href="https://ko-fi.com/patrickiel"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-3 w-full text-left py-2.5 px-3 hover:bg-hover text-fg decoration-transparent transition-colors"
      >
        <span
          class="flex-none flex items-center justify-center size-8.5 rounded-full text-pink-500 bg-pink-500/10"
        >
          <Icon name="heart" size={18} />
        </span>
        {@render actionText(
          'Support on Ko-fi',
          'If you enjoy this extension, consider leaving a tip!',
        )}
        <span class="flex text-muted ml-auto">
          <Icon name="popup" size={16} />
        </span>
      </a>
      <a
        href="https://github.com/patrickiel/note-by-note"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-3 w-full text-left py-2.5 px-3 hover:bg-hover text-fg decoration-transparent transition-colors border-t border-line"
      >
        <span class="flex-none flex items-center justify-center size-8.5 rounded-full text-accent-ink bg-accent-soft">
          <Icon name="github" size={18} />
        </span>
        {@render actionText(
          'Source code & issues',
          'Free and open source (GPL-2.0-or-later).',
        )}
        <span class="flex text-muted ml-auto">
          <Icon name="popup" size={16} />
        </span>
      </a>
    </div>

    <footer class="pt-1 pb-3 text-center text-[11px] text-faint">Version {version}</footer>
  </div>
</section>
