import { onMessage } from '../messaging/rpc';
import { applyCommand, canonical, emptyLibrary, mergeShared, type Library } from './library';
import { libraryItem } from './library-client';
import { parseBackupJson as parseLegacy } from './legacy-backup';
import { parseLibrary } from './backup-codec';
import { migrateBackup } from './library-migration';
import { bytesUsed, changedRecords, legacyKeys, PREFIX, readRecords } from '../../features/sync/persist/records';
import { loadSyncConfig, syncConfigItem, type SyncConfig } from '../../features/sync/persist/sync-config';

const WAKE = 'library-sync';
const SAFETY = 'library-sync-safety';

/** One writer for edits, imports and merges. Persisted records survive worker restarts. */
export function startLibraryBackground() {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };
  let ready: Promise<void> | undefined;
  const init = () => ready ??= (async () => {
    const raw = await browser.storage.local.get(null);
    if (!raw.library) {
      const defaults = emptyLibrary();
      const legacy = parseLegacy({ format: 'note-by-note-backup', version: 1,
        settings: raw.settings ?? defaults.shared.settings.value, uiPrefs: raw.uiPrefs ?? defaults.local.uiPrefs,
        history: raw.history ?? [], favorites: raw.favorites ?? [], eqPresets: raw.eqPresets ?? [],
        tracks: Object.entries(raw).filter(([key]) => key.startsWith('track:')).map(([, value]) => value),
      });
      await libraryItem.setValue(migrateBackup(legacy));
      // The old records remain recoverable; they are never read or written after migration.
    }
  })().catch((error) => { ready = undefined; throw error; });
  const saveConfig = (config: SyncConfig) => syncConfigItem.setValue(config);
  const schedule = async () => {
    const config = await loadSyncConfig();
    if (config.enabled) await browser.alarms.create(WAKE, { when: Math.max(Date.now() + 5000, config.lastPushAt + 30000) });
  };
  const reconcile = async () => {
    await init();
    const config = await loadSyncConfig();
    if (!config.enabled) return;
    await saveConfig({ ...config, syncing: true });
    try {
      const existing = await browser.storage.sync.get(null);
      config.usedBytes = bytesUsed(existing);
      const remote = await readRecords(existing);
      const local = await libraryItem.getValue();
      const shared = mergeShared(local.shared, remote);
      if (canonical(shared) !== canonical(local.shared)) await libraryItem.setValue({ ...local, shared });
      const changes = await changedRecords(shared, remote, existing);
      if (Object.keys(changes).length) {
        if (Date.now() < config.lastPushAt + 30000) { await schedule(); return; }
        // Legacy bytes may occupy the quota. Their contents are durable locally before removal.
        const oldKeys = legacyKeys(existing);
        if (oldKeys.length) await browser.storage.sync.remove(oldKeys);
        await browser.storage.sync.set(changes);
        config.lastPushAt = Date.now();
        const final = { ...existing, ...changes };
        for (const key of oldKeys) delete final[key];
        config.usedBytes = bytesUsed(final);
      }
      config.lastSyncedAt = Date.now();
      config.lastError = null;
    } catch (error) {
      config.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      await saveConfig({ ...config, syncing: false });
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
      await saveConfig({ ...config, enabled: false, syncing: false });
      await browser.alarms.clear(WAKE);
      if (data === 'delete') {
        const items = await browser.storage.sync.get(null);
        const keys = Object.keys(items).filter((key) => key.startsWith(PREFIX) || legacyKeys(items).includes(key));
        if (keys.length) await browser.storage.sync.remove(keys);
        await saveConfig({ ...config, enabled: false, syncing: false, lastSyncedAt: 0, usedBytes: 0, lastError: null });
      }
      return;
    }
    if (data === 'enable') await saveConfig({ ...config, enabled: true });
    await reconcile();
  }));
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WAKE || alarm.name === SAFETY) void enqueue(reconcile);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith(PREFIX) || key.startsWith('nbn.'))) {
      void enqueue(reconcile);
    }
  });
  // Recreate the safety alarm on each worker start. No panel has to stay open.
  void browser.alarms.create(SAFETY, { periodInMinutes: 1 });
  void enqueue(reconcile);
}
