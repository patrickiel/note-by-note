import { onMessage } from '../messaging/rpc';
import { applyCommand, emptyLibrary, newestSnapshot, type Library } from './library';
import { libraryItem } from './library-client';
import { parseLibrary } from './backup-codec';
import { recoverLegacyStorage } from './library-recovery';
import { bytesUsed, encodeSnapshot, hash, IncompleteSnapshot, PREFIX, readSnapshot, SNAPSHOT_KEY } from '../../features/sync/persist/records';
import { loadSyncConfig, syncConfigItem } from '../../features/sync/persist/sync-config';

const WAKE = 'library-sync';
const SAFETY = 'library-sync-safety';
/** Chromium allows ~2 writes/second sustained; one push per 30 s is well under
 * it and still lets a burst of edits ride out together. */
const PUSH_INTERVAL = 30000;
const INCOMPLETE_GRACE = 120000;

/** One writer for edits, imports and sync. Saved snapshots survive worker restarts. */
export function startLibraryBackground() {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };
  let ready: Promise<void> | undefined;
  const init = () => ready ??= (async () => {
    // Only the migration needs every old key. Ordinary wakes read one item.
    const { library } = await browser.storage.local.get('library');
    if (library !== undefined) {
      const normalized = parseLibrary(library);
      if (JSON.stringify(normalized) !== JSON.stringify(library)) await libraryItem.setValue(normalized);
    } else {
      await libraryItem.setValue(recoverLegacyStorage(await browser.storage.local.get(null)));
    }
  })().catch((error) => { ready = undefined; throw error; });
  const schedule = async () => {
    const config = await loadSyncConfig();
    if (config.enabled) await browser.alarms.create(WAKE, { when: Math.max(Date.now() + 5000, config.lastPushAt + PUSH_INTERVAL) });
  };
  const reconcile = async () => {
    const config = await loadSyncConfig();
    if (!config.enabled) return;
    const before = JSON.stringify(config);
    let active = false;
    const begin = async () => {
      if (!active) { active = true; await syncConfigItem.setValue({ ...config, syncing: true }); }
    };
    try {
      await init();
      const existing = await browser.storage.sync.get(null);
      config.usedBytes = bytesUsed(existing);
      const local = await libraryItem.getValue();
      const remote = await readSnapshot(existing).catch(async (error) => {
        // Repair an interrupted upload from our complete local copy. A newer
        // incomplete snapshot must finish arriving before we can choose a winner.
        if (error instanceof IncompleteSnapshot) {
          if (error.updatedAt !== null && local.shared.updatedAt >= error.updatedAt) return null;
          if (error.updatedAt === null) {
            const fingerprint = await hash(JSON.stringify(Object.entries(existing)
              .filter(([key]) => key.startsWith(PREFIX)).sort(([a], [b]) => a.localeCompare(b))));
            if (config.incompleteHash !== fingerprint || config.incompleteSince === undefined) {
              config.incompleteHash = fingerprint;
              config.incompleteSince = Date.now();
            }
            // Let separate key arrivals settle. A permanently orphaned upload
            // is repaired from our complete copy after a bounded, durable wait.
            if (Date.now() >= config.incompleteSince + INCOMPLETE_GRACE) return null;
            await browser.alarms.create(WAKE, { when: config.incompleteSince + INCOMPLETE_GRACE });
          }
        }
        throw error;
      });
      const shared = remote ? newestSnapshot(local.shared, remote) : local.shared;
      const adopting = shared !== local.shared;
      if (adopting) { await begin(); await libraryItem.setValue({ ...local, shared }); }
      config.lastError = null;
      delete config.incompleteSince;
      delete config.incompleteHash;
      const uploading = !remote || shared.updatedAt > remote.updatedAt || !existing[SNAPSHOT_KEY];
      if (uploading) {
        if (Date.now() < config.lastPushAt + PUSH_INTERVAL) { await schedule(); return; }
        await begin();
        const { items, usedBytes } = await encodeSnapshot(shared, existing);
        await browser.storage.sync.set(items);
        config.lastPushAt = Date.now();
        config.usedBytes = usedBytes;
      }
      if (adopting || uploading || !config.lastSyncedAt) config.lastSyncedAt = Date.now();
    } catch (error) {
      config.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      config.syncing = false;
      if (active || before !== JSON.stringify(config)) await syncConfigItem.setValue(config);
    }
  };
  onMessage('libraryRead', () => enqueue(async () => { await init(); return libraryItem.getValue(); }));
  onMessage('libraryEdit', ({ data }) => enqueue(async () => {
    let current: Library;
    if (data.type === 'import') {
      data.library = parseLibrary(data.library);
      // Recovery imports must work even when initialization cannot parse the
      // saved library. Keep that original available before replacing it.
      const raw = (await browser.storage.local.get('library')).library;
      try { current = raw === undefined ? emptyLibrary() : parseLibrary(raw); }
      catch {
        await browser.storage.local.set({ libraryRecovery: raw });
        current = emptyLibrary();
        const damaged = raw as Partial<Library> | null;
        const updatedAt = damaged?.shared?.updatedAt;
        const importRevision = damaged?.local?.importRevision;
        if (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0) current.shared.updatedAt = updatedAt;
        if (typeof importRevision === 'number' && Number.isSafeInteger(importRevision) && importRevision >= 0) current.local.importRevision = importRevision;
      }
    } else {
      await init();
      current = await libraryItem.getValue();
    }
    const next = applyCommand(current, data);
    await libraryItem.setValue(next);
    if (data.type === 'import') ready = Promise.resolve();
    if (current.shared.updatedAt !== next.shared.updatedAt) await schedule();
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
  // Creating an existing alarm postpones it. Keep its deadline across wakes;
  // recreate only when the browser has dropped it (for example after restart).
  void browser.alarms.get(SAFETY).then((alarm) => {
    if (!alarm) return browser.alarms.create(SAFETY, { periodInMinutes: 30 });
  });
  void enqueue(reconcile);
}
