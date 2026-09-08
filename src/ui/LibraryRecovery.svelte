<script lang="ts">
  import { parseBackup, restoreBackup } from '@/core/persist/backup';

  let { error }: { error: unknown } = $props();
  let busy = $state(false);
  let notice = $state('');
  const message = (value: unknown) => value instanceof Error ? value.message : String(value);

  async function exportRecovery() {
    try {
      const data = await browser.storage.local.get(null);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'note-by-note-recovery.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      notice = 'Original data exported. Keep this file for recovery; it is not an importable backup.';
    } catch (error) { notice = message(error); }
  }

  async function importFile(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    busy = true;
    try {
      const backup = parseBackup(await file.text());
      if (!confirm('Replace the saved library with this backup? A copy of the damaged library will be kept on this device.')) return;
      await restoreBackup(backup);
      location.reload();
    } catch (error) { notice = message(error); }
    finally { busy = false; }
  }
</script>

<main class="p-5 text-fg" aria-label="Library recovery">
  <h1 class="text-lg font-semibold">Your saved library could not be opened</h1>
  <p class="mt-3 text-sm">Your saved data is still on this device. Retry, keep a copy of the original data, or restore an existing Note by Note backup.</p>
  <p class="mt-2 text-sm text-muted">{message(error)}</p>
  <div class="mt-4 flex flex-wrap gap-3 text-sm">
    <button class="rounded border border-line px-3 py-2" onclick={() => location.reload()} disabled={busy}>Retry</button>
    <button class="rounded border border-line px-3 py-2" onclick={exportRecovery} disabled={busy}>Export original data</button>
    <label class="rounded border border-line px-3 py-2">
      Import backup
      <input type="file" accept=".json,application/json" class="mt-2 block max-w-full" aria-label="Import backup" onchange={importFile} disabled={busy} />
    </label>
  </div>
  {#if notice}<p class="mt-3 text-sm" role="status">{notice}</p>{/if}
</main>
