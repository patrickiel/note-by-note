import { createBackup, restoreBackup, type Backup } from '../../../core/persist/backup';
import {
  DEFAULT_SYNC_CONFIG,
  generateSyncId,
  loadSyncState,
  SYNC_ID_RE,
  syncConfigItem,
  syncIdItem,
  type SyncConfig,
} from '../persist/sync-config';
import { session } from '../../../core/state/session.svelte';
import { deleteSnapshot, pullSnapshot, pushSnapshot, SyncHttpError } from './api';
import { snapshotHash } from './hash';

/** Trailing debounce after the last data change before pushing. */
const PUSH_DEBOUNCE_MS = 5000;
/** How often to check the server for another device's changes. */
const PULL_INTERVAL_MS = 5 * 60 * 1000;

/** Raw storage keys (no `local:` prefix in change events) that belong to the
 * backup snapshot. `syncConfig` itself is deliberately absent. */
const SYNCED_KEY_RE = /^(settings|uiPrefs|history|favorites|eqPresets|track:)/;

function errorMessage(err: unknown): string {
  if (err instanceof SyncHttpError) return err.message;
  if (err instanceof TypeError) return 'Could not reach the sync server.';
  return err instanceof Error ? err.message : 'Sync failed.';
}

/**
 * Device sync: mirrors the backup snapshot (see `persist/backup.ts`) to the
 * sync server under a secret ID, last-write-wins. Local changes are detected
 * via storage change events and pushed after a debounce; remote changes are
 * pulled at startup and on an interval, and applied via `restoreBackup` plus
 * a panel reload (stores read storage once at startup — same rationale as the
 * import flow in SettingsView).
 *
 * Runs only in the sidepanel: it is the sole writer of synced data, so there
 * is nothing to observe while it's closed. A change the panel didn't manage
 * to push before closing is remembered via `pendingPush`.
 */
class SyncStore {
  enabled = $state(false);
  syncId = $state<string | null>(null);
  lastSyncedAt = $state(0);
  lastError = $state<string | null>(null);
  /** An ID arrived from another device while this one already held data of its
   * own. Applying would overwrite it, so the panel asks first — see
   * `acceptRemote` / `keepLocal`. */
  needsConsent = $state(false);
  #syncing = $state(false);

  status = $derived<'off' | 'syncing' | 'error' | 'idle'>(
    !this.enabled ? 'off' : this.#syncing ? 'syncing' : this.lastError ? 'error' : 'idle',
  );

  #config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
  /** Mirrors `syncIdItem` — the ID lives in browser-synced storage (see
   * `persist/sync-config.ts`), separate from the per-device bookkeeping. */
  #id: string | null = null;
  #writing = false;
  /** Suppresses change events while `restoreBackup` writes a remote snapshot,
   * so applying can't schedule a push of what was just pulled. */
  #applying = false;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes pushes and reconciles so they can't interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  async init() {
    const { config, syncId } = await loadSyncState();
    this.#config = config;
    this.#id = syncId;
    this.#reflect();
    syncConfigItem.watch((value) => {
      if (this.#writing) return;
      this.#config = value ?? { ...DEFAULT_SYNC_CONFIG };
      this.#reflect();
    });
    // The ID is browser-synced: another device on this browser profile can
    // hand this one an ID (or replace it) at any time.
    syncIdItem.watch((value) => {
      if (this.#writing || value === this.#id) return;
      this.#id = value;
      this.#reflect();
      if (!this.#config.enabled || !value) return;
      // Identity changed while enabled: the bookkeeping refers to the old
      // blob — reset it and reconcile against the new one.
      void this.#saveConfig({ lastSyncedAt: 0, lastSyncedHash: null, pendingPush: false }).then(
        () => this.#startReconcile({ allowApply: session.media === null }),
      );
    });

    browser.storage.local.onChanged.addListener((changes) => {
      if (this.#applying) return;
      if (!this.#config.enabled) return;
      if (!Object.keys(changes).some((key) => SYNCED_KEY_RE.test(key))) return;
      this.#onDataChanged();
    });

    if (this.#config.enabled && this.#id) {
      await this.#startReconcile({ allowApply: true });
    }

    // A track being loaded defers remote applies (the reload would interrupt
    // practice) to the next panel open or a manual "Sync now".
    setInterval(() => {
      if (!this.#config.enabled || !this.#id) return;
      void this.#startReconcile({ allowApply: session.media === null });
    }, PULL_INTERVAL_MS);
  }

  /**
   * Reconcile, but never silently overwrite data this device already has.
   *
   * Sync ships on, and the ID rides browser-profile sync, so a device can be
   * handed an identity it never asked for. When that device is empty (a fresh
   * install — the case this default exists for) adopting is what the user
   * wants and there is nothing to lose, so consent is implied. When it already
   * holds a library, applying the remote would delete it: raise `needsConsent`
   * and let the panel ask instead.
   */
  async #startReconcile(opts: { allowApply: boolean }) {
    const id = this.#id;
    if (!this.#config.enabled || !id) return;
    if (this.#config.consentedId !== id) {
      if (!(await this.#isPristine())) {
        this.needsConsent = true;
        return;
      }
      await this.#saveConfig({ consentedId: id });
    }
    await this.#enqueue(() => this.#reconcile(opts));
  }

  /** Nothing here a remote snapshot could destroy. Settings and UI prefs are
   * excluded deliberately — they are a keystroke to redo, and weighing them
   * would make the common "installed, opened it once" path prompt for nothing. */
  async #isPristine(): Promise<boolean> {
    const local = await createBackup();
    return (
      local.history.length === 0 &&
      local.favorites.length === 0 &&
      local.tracks.length === 0 &&
      local.eqPresets.length === 0
    );
  }

  /** User chose the synced copy: apply it over this device's data. */
  async acceptRemote(): Promise<void> {
    const id = this.#id;
    if (!id) return;
    this.needsConsent = false;
    await this.#saveConfig({ consentedId: id });
    await this.#enqueue(() => this.#reconcile({ allowApply: true }));
  }

  /** User chose this device's data: keep it and let it win the next push. */
  async keepLocal(): Promise<void> {
    const id = this.#id;
    if (!id) return;
    this.needsConsent = false;
    await this.#saveConfig({ consentedId: id, lastChangedAt: Date.now(), pendingPush: true });
    await this.#enqueue(() => this.#push({ force: true }));
  }

  /** Turns sync on. With no ID anywhere — none kept from an earlier enable,
   * none received from another device via browser sync — generates one and
   * uploads this device's data; otherwise reuses the ID and reconciles. */
  async enable(): Promise<void> {
    const fresh = this.#id === null;
    const id = this.#id ?? generateSyncId();
    await this.#saveId(id);
    // Turning it on by hand is the consent.
    await this.#saveConfig({ enabled: true, consentedId: id, lastError: null });
    this.needsConsent = false;
    await this.#enqueue(() =>
      fresh ? this.#push({ force: true }) : this.#reconcile({ allowApply: true }),
    );
  }

  /** Keeps the ID so re-enabling picks the same remote blob back up. */
  async disable(): Promise<void> {
    clearTimeout(this.#pushTimer);
    this.needsConsent = false;
    await this.#saveConfig({ enabled: false });
  }

  /**
   * Removes this ID's snapshot from the server. Sync is switched off too —
   * leaving it on would re-upload from the next change and quietly undo the
   * deletion. The ID is kept, so turning sync back on starts a fresh blob.
   */
  async deleteRemote(): Promise<void> {
    const id = this.#id;
    if (!id) return;
    clearTimeout(this.#pushTimer);
    this.needsConsent = false;
    await this.#enqueue(async () => {
      this.#syncing = true;
      try {
        await deleteSnapshot(id);
        await this.#saveConfig({
          enabled: false,
          lastSyncedAt: 0,
          lastSyncedHash: null,
          pendingPush: false,
          lastError: null,
        });
      } catch (err) {
        await this.#saveConfig({ lastError: errorMessage(err) });
        throw err;
      } finally {
        this.#syncing = false;
      }
    });
  }

  /**
   * Links this device to an existing sync ID. Pull-first: existing remote data
   * replaces this device's (the UI confirms beforehand; ends in a reload) and
   * never the other way around — a fresh install must not clobber the remote.
   * Returns 'uploaded' when the ID had no data yet and local data seeded it.
   */
  async connectWithId(rawId: string): Promise<'applied' | 'uploaded'> {
    const id = rawId.trim();
    if (!SYNC_ID_RE.test(id)) throw new Error("That doesn't look like a sync ID.");
    await this.#saveId(id);
    // Typing in someone else's ID, past the UI's confirm, is the consent.
    await this.#saveConfig({
      enabled: true,
      consentedId: id,
      lastSyncedAt: 0,
      lastSyncedHash: null,
      pendingPush: false,
      lastError: null,
    });
    this.needsConsent = false;
    return this.#enqueue(async () => {
      try {
        const remote = await pullSnapshot(id);
        if (remote) {
          await this.#applyRemote(remote);
          return 'applied' as const;
        }
        await this.#push({ force: true });
        return 'uploaded' as const;
      } catch (err) {
        await this.#saveConfig({ lastError: errorMessage(err) });
        throw err;
      }
    });
  }

  async syncNow(): Promise<void> {
    await this.#startReconcile({ allowApply: true });
  }

  #reflect() {
    this.enabled = this.#config.enabled;
    this.syncId = this.#id;
    this.lastSyncedAt = this.#config.lastSyncedAt;
    this.lastError = this.#config.lastError;
    if (!this.#config.enabled || this.#config.consentedId === this.#id) this.needsConsent = false;
  }

  /** Sync-area writes are quota-limited (~120/min), so no-ops are skipped. */
  async #saveId(id: string | null) {
    if (id === this.#id) return;
    this.#id = id;
    this.#reflect();
    this.#writing = true;
    try {
      await syncIdItem.setValue(id);
    } finally {
      this.#writing = false;
    }
  }

  async #saveConfig(patch: Partial<SyncConfig>) {
    this.#config = { ...this.#config, ...patch };
    this.#reflect();
    this.#writing = true;
    try {
      await syncConfigItem.setValue(this.#config);
    } finally {
      this.#writing = false;
    }
  }

  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op, op);
    this.#queue = result.catch(() => {});
    return result;
  }

  #onDataChanged() {
    // Persisted immediately (not on the debounce) so a panel closed mid-burst
    // still knows there is unpushed data next time it opens.
    void this.#saveConfig({ pendingPush: true, lastChangedAt: Date.now() });
    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => {
      void this.#enqueue(() => this.#push());
    }, PUSH_DEBOUNCE_MS);
  }

  /** Uploads the current snapshot. The hash guard makes echoes (and no-op
   * writes) free; `force` skips it for seeding an empty remote. */
  async #push(opts: { force?: boolean } = {}) {
    if (!this.#config.enabled) return;
    // Sync ships on, but an ID is minted only once there is something to push.
    // Deferring leaves room for a profile-synced ID from another device to
    // arrive first, and avoids seeding a blob for an install nobody uses.
    // Minting our own means this device started the data set — consent implied.
    if (!this.#id) {
      const minted = generateSyncId();
      await this.#saveId(minted);
      await this.#saveConfig({ consentedId: minted });
      opts = { force: true };
    }
    const id = this.#id;
    if (!id) return;
    this.#syncing = true;
    try {
      const local = await createBackup();
      const hash = await snapshotHash(local);
      if (!opts.force && hash === this.#config.lastSyncedHash) {
        if (this.#config.pendingPush || this.#config.lastError) {
          await this.#saveConfig({ pendingPush: false, lastError: null });
        }
        return;
      }
      await pushSnapshot(id, local);
      await this.#saveConfig({
        lastSyncedAt: local.exportedAt,
        lastSyncedHash: hash,
        pendingPush: false,
        lastError: null,
      });
    } catch (err) {
      // pendingPush stays set — retried on the next change, interval tick,
      // startup, or manual sync. No retry timer.
      await this.#saveConfig({ lastError: errorMessage(err) });
    } finally {
      this.#syncing = false;
    }
  }

  /** Pull-and-decide: push, apply remote, or nothing — last write wins. */
  async #reconcile(opts: { allowApply: boolean }) {
    const id = this.#id;
    if (!this.#config.enabled || !id) return;
    this.#syncing = true;
    try {
      const remote = await pullSnapshot(id);
      const local = await createBackup();
      const localHash = await snapshotHash(local);
      const localChanged = localHash !== this.#config.lastSyncedHash;

      if (remote === null) {
        // First device on this ID, or the blob expired server-side: seed it.
        await this.#uploadLocal(local, localHash);
        return;
      }
      if (remote.exportedAt === this.#config.lastSyncedAt) {
        // Remote is still what we last synced; push if we have news.
        if (localChanged || this.#config.pendingPush) await this.#uploadLocal(local, localHash);
        else if (this.#config.lastError) await this.#saveConfig({ lastError: null });
        return;
      }
      // Another device pushed since our last sync.
      if ((await snapshotHash(remote)) === localHash) {
        // Same content, different timestamp — adopt its bookkeeping, skip the reload.
        await this.#saveConfig({
          lastSyncedAt: remote.exportedAt,
          lastSyncedHash: localHash,
          pendingPush: false,
          lastError: null,
        });
        return;
      }
      if (!localChanged || remote.exportedAt > this.#config.lastChangedAt) {
        if (opts.allowApply) await this.#applyRemote(remote);
        // else: deferred — don't push over a newer remote either.
      } else {
        await this.#uploadLocal(local, localHash);
      }
    } catch (err) {
      await this.#saveConfig({ lastError: errorMessage(err) });
    } finally {
      this.#syncing = false;
    }
  }

  async #uploadLocal(local: Backup, hash: string) {
    const id = this.#id;
    if (!id) return;
    await pushSnapshot(id, local);
    await this.#saveConfig({
      lastSyncedAt: local.exportedAt,
      lastSyncedHash: hash,
      pendingPush: false,
      lastError: null,
    });
  }

  /** Overwrites local data with the remote snapshot and reloads the panel
   * (mirrors the import flow — stores read storage once at startup). The hash
   * is taken from a re-read because `parseBackup` backfills defaults, so what
   * landed in storage can differ from the remote bytes. */
  async #applyRemoteImpl(remote: Backup) {
    await restoreBackup(remote);
    const applied = await createBackup();
    await this.#saveConfig({
      lastSyncedAt: remote.exportedAt,
      lastSyncedHash: await snapshotHash(applied),
      pendingPush: false,
      lastError: null,
    });
    // After the reload, reconcile sees remote.exportedAt === lastSyncedAt and
    // an unchanged hash — no loop.
    location.reload();
  }

  async #applyRemote(remote: Backup) {
    // #applying stays set: the page is about to reload, and nothing that
    // happens between restore and reload should schedule a push.
    this.#applying = true;
    clearTimeout(this.#pushTimer);
    try {
      await this.#applyRemoteImpl(remote);
    } catch (err) {
      this.#applying = false;
      throw err;
    }
  }
}

export const sync = new SyncStore();
