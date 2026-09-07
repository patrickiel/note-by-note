import { onMessage } from '../messaging/rpc';
import { applyCommand, canonical, emptyLibrary, mergeShared, pruned, type Library } from './library';
import { libraryItem } from './library-client';
import { parseBackupJson as parseLegacy } from './legacy-backup';
import { parseLibrary } from './backup-codec';
import { migrateBackup } from './library-migration';
import { bytesUsed, changedRecords, PREFIX, readRecords, skippedMessage } from '../../features/sync/persist/records';
import { loadSyncConfig, syncConfigItem } from '../../features/sync/persist/sync-config';

const WAKE = 'library-sync';
const SAFETY = 'library-sync-safety';
/** Chromium allows ~2 writes/second sustained; one push per 30 s is well under
 * it and still lets a burst of edits ride out together. */
const PUSH_INTERVAL = 30000;

/** One writer for edits, imports and merges. Persisted records survive worker restarts. */
export function startLibraryBackground() {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };
  /** `parseLegacy` rejects a damaged file, which is right for a backup the user
   * picked but fatal here: a single bad row would leave the panel with no
   * library at all, on every start, forever. Unusable rows are dropped instead,
   * and a parse that still fails yields an empty library. Either way the old
   * records are left in place, so nothing is beyond recovery. */
  const migrate = (raw: Record<string, unknown>): Library => {
    const defaults = emptyLibrary();
    const identified = (value: unknown) => (Array.isArray(value) ? value : []).filter((row) =>
      typeof (row as { identity?: { normalizedUrl?: unknown } })?.identity?.normalizedUrl === 'string');
    try {
      return migrateBackup(parseLegacy({ format: 'note-by-note-backup', version: 1,
        settings: raw.settings, uiPrefs: raw.uiPrefs,
        history: identified(raw.history), favorites: identified(raw.favorites),
        eqPresets: Array.isArray(raw.eqPresets) ? raw.eqPresets : [],
        tracks: identified(Object.entries(raw).filter(([key]) => key.startsWith('track:')).map(([, value]) => value)),
      }));
    } catch (error) {
      console.error('[note-by-note] the previous library could not be migrated; its records are kept', error);
      return defaults;
    }
  };
  let ready: Promise<void> | undefined;
  const init = () => ready ??= (async () => {
    // Only the migration needs every old key. Ordinary wakes read one item.
    if ((await browser.storage.local.get('library')).library) return;
    // Pruned on the way in: an old library can hold far more songs than sync
    // allows, and without this the first reconcile would fail on every retry.
    await libraryItem.setValue(pruned(migrate(await browser.storage.local.get(null))));
  })().catch((error) => { ready = undefined; throw error; });
  const schedule = async () => {
    const config = await loadSyncConfig();
    if (config.enabled) await browser.alarms.create(WAKE, { when: Math.max(Date.now() + 5000, config.lastPushAt + PUSH_INTERVAL) });
  };
  const reconcile = async () => {
    await init();
    const config = await loadSyncConfig();
    if (!config.enabled) return;
    await syncConfigItem.setValue({ ...config, syncing: true });
    try {
      const existing = await browser.storage.sync.get(null);
      config.usedBytes = bytesUsed(existing);
      const remote = await readRecords(existing);
      const local = await libraryItem.getValue();
      // Pruned here too: a merge can carry in more songs than the limits allow,
      // and only `applyCommand` would otherwise ever bring it back under them.
      const merged = pruned({ ...local, shared: mergeShared(local.shared, remote) });
      if (canonical(merged) !== canonical(local)) await libraryItem.setValue(merged);
      const { changes, removals, skipped, usedBytes } = await changedRecords(merged.shared, remote, existing);
      // Recorded before the throttle returns, or a merge that succeeded would
      // leave the previous run's error on screen until a push happens to be due.
      config.lastSyncedAt = Date.now();
      config.lastError = skipped.length ? skippedMessage(skipped) : null;
      if (Object.keys(changes).length || removals.length) {
        if (Date.now() < config.lastPushAt + PUSH_INTERVAL) { await schedule(); return; }
        if (removals.length) await browser.storage.sync.remove(removals);
        if (Object.keys(changes).length) await browser.storage.sync.set(changes);
        config.lastPushAt = Date.now();
        config.usedBytes = usedBytes;
      }
    } catch (error) {
      config.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      await syncConfigItem.setValue({ ...config, syncing: false });
    }
  };
  onMessage('libraryRead', () => enqueue(async () => { await init(); return libraryItem.getValue(); }));
  onMessage('libraryEdit', ({ data }) => enqueue(async () => {
    await init();
    if (data.type === 'import') data.library = parseLibrary(data.library);
    const current = await libraryItem.getValue();
    const next = applyCommand(current, data);
    await libraryItem.setValue(next);
    if (canonical(current.shared) !== canonical(next.shared)) await schedule();
  }));
  onMessage('librarySync', ({ data }) => enqueue(async () => {
    const config = await loadSyncConfig();
    if (data === 'disable' || data === 'delete') {
      // Disabled before anything is removed, so a worker restart part-way
      // through the delete cannot wake up and upload the library again.
      await syncConfigItem.setValue(data === 'delete'
        ? { ...config, enabled: false, syncing: false, lastSyncedAt: 0, usedBytes: 0, lastError: null }
        : { ...config, enabled: false, syncing: false });
      await browser.alarms.clear(WAKE);
      if (data === 'delete') {
        const items = await browser.storage.sync.get(null);
        const keys = Object.keys(items).filter((key) => key.startsWith(PREFIX));
        if (keys.length) await browser.storage.sync.remove(keys);
      }
      return;
    }
    if (data === 'enable') await syncConfigItem.setValue({ ...config, enabled: true });
    await reconcile();
  }));
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WAKE || alarm.name === SAFETY) void enqueue(reconcile);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith(PREFIX))) {
      void enqueue(reconcile);
    }
  });
  // Recreate the safety alarm on each worker start. No panel has to stay open.
  // Only a net: `libraryEdit` schedules WAKE and `storage.onChanged` catches
  // remote writes, so this never needs to be the thing that notices a change —
  // and each run wakes the worker to decompress every record.
  void browser.alarms.create(SAFETY, { periodInMinutes: 30 });
  void enqueue(reconcile);
}
