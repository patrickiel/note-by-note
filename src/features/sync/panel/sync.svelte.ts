import { createBackup, type Backup } from '../../../core/persist/backup';
import { session } from '../../../core/state/session.svelte';
import { applySyncSnapshot } from '../persist/apply';
import { fitSnapshot, SnapshotTooLargeError, type Fitted } from '../persist/fit';
import { snapshotHash } from '../persist/hash';
import {
  classifySyncError,
  clearSyncArea,
  onSyncAreaChanged,
  readSyncArea,
  syncErrorMessage,
  writeSyncArea,
} from '../persist/sync-area';
import {
  blobToItems,
  BUDGET_CHARS,
  encodeSnapshot,
  itemsBytes,
  META_KEY,
  SYNC_QUOTA_BYTES,
  type EncodedBlob,
} from '../persist/sync-blob';
import {
  DEFAULT_SYNC_CONFIG,
  loadSyncState,
  syncConfigItem,
  type SyncConfig,
} from '../persist/sync-config';
import { snapshotToBackup, type SyncSnapshot } from '../persist/sync-snapshot';

/** Trailing debounce after the last data change before pushing. */
const PUSH_DEBOUNCE_MS = 5000;
/** Floor between two pushes. Each is one or two write operations against the
 * browser's 120/min and 1,800/h caps; this keeps a long editing session at a
 * handful per minute. */
const MIN_PUSH_SPACING_MS = 30_000;
/** A remote write lands as several change events (chunks, meta, a removal of
 * stale chunks); wait for the burst to settle before reading. */
const REMOTE_DEBOUNCE_MS = 1000;
/** A torn read means another device is mid-write; look again shortly. */
const TORN_RETRY_MS = 5000;
/** A read still torn this long after the first is not a write in flight —
 * two devices wrote at once and the per-key merge left the area in a state
 * no one will ever write again (one side's meta with the other's chunks, or
 * a shrinking write's cleanup having removed chunks a larger concurrent one
 * added). Nothing reads it, so nothing pushes; this device re-seeds it —
 * after a random extra wait of up to the same again, so two devices don't
 * re-seed together and tear it a second time. */
const TORN_REPAIR_MS = 30_000;
/** Write caps are per minute; wait one out before retrying. */
const RATE_LIMIT_RETRY_MS = 65_000;
/** Change events are the real signal; this is the net under them. */
const SAFETY_INTERVAL_MS = 15 * 60_000;

/** Raw storage keys (no `local:` prefix in change events) that belong to the
 * backup snapshot. `syncConfig` itself is deliberately absent. */
const SYNCED_KEY_RE = /^(settings|uiPrefs|history|favorites|eqPresets|deletions|track:)/;

/**
 * Device sync over the browser's own extension sync storage — the backup
 * snapshot (see `persist/backup.ts`), compacted and gzipped into the
 * `nbn.*` items (`persist/sync-blob.ts`) and trimmed by priority to the
 * quota (`persist/fit.ts`), last-write-wins on `exportedAt`. Local changes
 * are detected via storage change events and pushed after a debounce; remote
 * ones arrive as `storage.sync` change events and are applied via
 * `applySyncSnapshot` plus a panel reload (stores read storage once at
 * startup — same rationale as the import flow in SettingsView).
 *
 * Three hashes, each with one job:
 * - `config.lastSyncedHash`: the raw local data at last sync. Any local edit
 *   changes it, so it decides whether there is something to push.
 * - the content hash of a *fitted* snapshot (`snapshotToBackup` → `snapshotHash`):
 *   comparable across devices, because both sides went through the same
 *   lossy encoding. It decides whether a differing remote is really different.
 * - `meta.hash` of the blob: integrity of a read, and recognising our own
 *   write when it echoes back as a change event.
 *
 * Runs only in the sidepanel: it is the sole writer of synced data, so there
 * is nothing to observe while it's closed. A change the panel didn't manage
 * to push before closing is remembered via `pendingPush`.
 */
class SyncStore {
  enabled = $state(false);
  lastSyncedAt = $state(0);
  lastError = $state<string | null>(null);
  /** A snapshot from another device was found while this one already held
   * data of its own. Applying would overwrite it, so the panel asks first —
   * see `acceptRemote` / `keepLocal`. */
  needsConsent = $state(false);
  /** The last push left something out to fit the quota. */
  trimmed = $state(false);
  /** Occupancy of the browser's sync area as of the last read or write;
   * 0 until the first reconcile of this panel document. */
  usedBytes = $state(0);
  #syncing = $state(false);

  status = $derived<'off' | 'syncing' | 'error' | 'idle'>(
    !this.enabled ? 'off' : this.#syncing ? 'syncing' : this.lastError ? 'error' : 'idle',
  );
  /** Share of the 100 KB quota in use, whole percent, at least 1 while
   * anything is stored so a tiny library doesn't read as empty. */
  usedPercent = $derived(
    this.usedBytes === 0
      ? 0
      : Math.min(100, Math.max(1, Math.round((this.usedBytes / SYNC_QUOTA_BYTES) * 100))),
  );

  #config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
  /** Suppresses the echo of our own `syncConfigItem` write. */
  #writing = false;
  /** Suppresses change events while a remote snapshot is being written into
   * local storage, so applying can't schedule a push of what was just pulled. */
  #applying = false;
  /** Suppresses sync-area change events while our own blob is being written
   * (the stale-chunk removal arrives as an event without a meta). */
  #writingRemote = false;
  /** `meta.hash` of the blob we last wrote — our own echo carries it. */
  #lastBlobHash: string | null = null;
  /** When this device gives up waiting for a torn area to heal and re-seeds
   * it; 0 while reads are whole. */
  #tornDeadline = 0;
  #lastPushAt = 0;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  #remoteTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes reconciles so they can't interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  async init() {
    this.#config = await loadSyncState();
    this.#reflect();
    // Watchers go up before any write below, so nothing arriving from another
    // device in the meantime is missed.
    syncConfigItem.watch((value) => {
      if (this.#writing) return;
      this.#config = value ?? { ...DEFAULT_SYNC_CONFIG };
      this.#reflect();
    });
    onSyncAreaChanged((changes) => {
      if (!this.#config.enabled || this.#writingRemote) return;
      const meta = changes[META_KEY]?.newValue as { hash?: unknown } | undefined;
      if (meta && meta.hash === this.#lastBlobHash) return;
      // A removal (an uninstall elsewhere emptied the area) schedules too: the
      // read comes back `none` and this device seeds it again.
      this.#scheduleRemote();
    });
    browser.storage.local.onChanged.addListener((changes) => {
      if (this.#applying) return;
      if (!this.#config.enabled) return;
      if (!Object.keys(changes).some((key) => SYNCED_KEY_RE.test(key))) return;
      this.#onDataChanged();
    });

    if (this.#config.enabled) {
      await this.#enqueue(() => this.#reconcile({ allowApply: true }));
    }

    // A track being loaded defers remote applies (the reload would interrupt
    // practice) to the next panel open or a manual "Sync now".
    setInterval(() => {
      if (!this.#config.enabled) return;
      void this.#enqueue(() => this.#reconcile({ allowApply: session.media === null }));
    }, SAFETY_INTERVAL_MS);
  }

  /** User chose the synced copy: apply it over this device's data. */
  async acceptRemote(): Promise<void> {
    this.needsConsent = false;
    await this.#saveConfig({ consented: true });
    await this.#enqueue(() => this.#reconcile({ allowApply: true }));
  }

  /** User chose this device's data: keep it and let it win the next push. */
  async keepLocal(): Promise<void> {
    this.needsConsent = false;
    await this.#saveConfig({ consented: true, lastChangedAt: Date.now(), pendingPush: true });
    await this.#enqueue(() => this.#reconcile({ allowApply: false }));
  }

  /** Turns sync on and meets whatever is in the area. A snapshot from another
   * device raises `needsConsent` from inside the reconcile if this device has
   * data of its own to lose. */
  async enable(): Promise<void> {
    await this.#saveConfig({ enabled: true, lastError: null });
    await this.#enqueue(() => this.#reconcile({ allowApply: true }));
  }

  /** Keeps the bookkeeping so re-enabling picks up where it left off. */
  async disable(): Promise<void> {
    this.#clearTimers();
    this.needsConsent = false;
    await this.#saveConfig({ enabled: false });
  }

  /**
   * Removes the blob from the browser's sync area. Sync is switched off on
   * this device too — leaving it on would re-upload from the next change and
   * quietly undo the deletion. Other devices with sync on do exactly that
   * (they see the area emptied and seed it again), which is also what makes
   * an uninstall on one device harmless; the Settings copy says so.
   */
  async deleteRemote(): Promise<void> {
    this.#clearTimers();
    this.needsConsent = false;
    await this.#enqueue(async () => {
      this.#syncing = true;
      try {
        await clearSyncArea();
        this.#lastBlobHash = null;
        this.usedBytes = 0;
        await this.#saveConfig({
          enabled: false,
          lastSyncedAt: 0,
          lastSyncedHash: null,
          pendingPush: false,
          lastError: null,
          consented: false,
          trimmed: false,
        });
      } catch (err) {
        await this.#saveConfig({ lastError: syncErrorMessage(err) });
        throw err;
      } finally {
        this.#syncing = false;
      }
    });
  }

  /** The user asked, so a torn area is repaired now rather than after
   * `TORN_REPAIR_MS`. */
  async syncNow(): Promise<void> {
    await this.#enqueue(() => this.#reconcile({ allowApply: true, repairTorn: true }));
  }

  /** Nothing here a remote snapshot could destroy. Settings and UI prefs are
   * excluded deliberately — they are a keystroke to redo, and weighing them
   * would make the common "installed, opened it once" path prompt for nothing. */
  #isPristine(local: Backup): boolean {
    return (
      local.history.length === 0 &&
      local.favorites.length === 0 &&
      local.tracks.length === 0 &&
      local.eqPresets.length === 0
    );
  }

  #reflect() {
    this.enabled = this.#config.enabled;
    this.lastSyncedAt = this.#config.lastSyncedAt;
    this.lastError = this.#config.lastError;
    this.trimmed = this.#config.trimmed;
    if (!this.#config.enabled || this.#config.consented) this.needsConsent = false;
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

  #clearTimers() {
    clearTimeout(this.#pushTimer);
    clearTimeout(this.#remoteTimer);
    clearTimeout(this.#retryTimer);
  }

  #onDataChanged() {
    // Persisted immediately (not on the debounce) so a panel closed mid-burst
    // still knows there is unpushed data next time it opens.
    void this.#saveConfig({ pendingPush: true, lastChangedAt: Date.now() });
    const now = Date.now();
    const wait = Math.max(PUSH_DEBOUNCE_MS, this.#lastPushAt + MIN_PUSH_SPACING_MS - now);
    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => {
      // A push reads first, so it can never overwrite a newer remote; applying
      // one is left to the next open or "Sync now" — mid-edit is no time for
      // a reload.
      void this.#enqueue(() => this.#reconcile({ allowApply: false }));
    }, wait);
  }

  #scheduleRemote() {
    clearTimeout(this.#remoteTimer);
    this.#remoteTimer = setTimeout(() => {
      void this.#enqueue(() => this.#reconcile({ allowApply: session.media === null }));
    }, REMOTE_DEBOUNCE_MS);
  }

  #scheduleRetry(delay: number) {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      void this.#enqueue(() => this.#reconcile({ allowApply: false }));
    }, delay);
  }

  #fit(local: Backup, repaired = false): Promise<Fitted<EncodedBlob>> {
    return fitSnapshot(
      local,
      async (snapshot) => {
        const blob = await encodeSnapshot(snapshot);
        return { size: blob.size, payload: blob };
      },
      BUDGET_CHARS,
      { exportedAt: local.exportedAt, appVersion: local.appVersion, repaired },
    );
  }

  /** Read-and-decide: push, apply remote, or nothing — last write wins. */
  async #reconcile(opts: { allowApply: boolean; repairTorn?: boolean }) {
    if (!this.#config.enabled) return;
    this.#syncing = true;
    try {
      const read = await readSyncArea();
      this.usedBytes = read.bytes;
      const local = await createBackup();
      const localHash = await snapshotHash(local);
      const localChanged = localHash !== this.#config.lastSyncedHash;

      if (read.kind === 'torn') {
        this.#tornDeadline ||= Date.now() + TORN_REPAIR_MS * (1 + Math.random());
        // Only a device that has joined the data set may re-seed. The torn
        // blob's writers still hold their data locally and reconcile against
        // the re-seeded area like any other remote write; a fresh install
        // has nothing to seed with and would only hand them empty lists.
        const stuck = opts.repairTorn || Date.now() >= this.#tornDeadline;
        if (stuck && this.#config.consented) {
          this.#tornDeadline = 0;
          await this.#reseed(local, localHash);
        } else {
          this.#scheduleRetry(TORN_RETRY_MS);
        }
        return;
      }
      this.#tornDeadline = 0;

      if (read.kind === 'none') {
        // Empty area: first device, or the blob was cleared. Seeding it is
        // starting the data set — consent implied.
        if (!this.#config.consented) await this.#saveConfig({ consented: true });
        await this.#uploadLocal(local, localHash);
        return;
      }
      const remote = read.snapshot;
      if (remote.exportedAt === this.#config.lastSyncedAt) {
        // Remote is still what we last synced; push if we have news.
        if (localChanged || this.#config.pendingPush) await this.#uploadLocal(local, localHash);
        else if (this.#config.lastError) await this.#saveConfig({ lastError: null });
        return;
      }
      if (remote.repaired && remote.exportedAt < this.#config.lastSyncedAt) {
        // A device re-seeded from data older than what we last synced; ours
        // is newer, so it goes back up — as a re-seed too, under its own
        // clock, so a third device holding something newer still can answer
        // the same way. The chain ends at the newest copy, which every other
        // device then applies like any other newer write.
        await this.#reseed(local, localHash);
        return;
      }
      // Another device wrote since our last sync. Compare what we *would*
      // push, not the raw local data — trimming and rounding are lossy.
      const wouldApply = !localChanged || remote.exportedAt > this.#config.lastChangedAt;
      let fitted: Fitted<EncodedBlob> | undefined;
      try {
        fitted = await this.#fit(local);
      } catch (err) {
        // Local data too large to push is no reason not to take the remote:
        // that is a plain apply, and if its Favorites are smaller it is also
        // what gets this device back under the quota. Only the push needs a fit.
        if (!(err instanceof SnapshotTooLargeError) || !wouldApply) throw err;
      }
      if (fitted) {
        const [remoteHash, ownHash] = await Promise.all([
          snapshotHash(snapshotToBackup(remote)),
          snapshotHash(snapshotToBackup(fitted.snapshot)),
        ]);
        if (remoteHash === ownHash) {
          // Same content, different timestamp — adopt its bookkeeping, skip the reload.
          await this.#saveConfig({
            lastSyncedAt: remote.exportedAt,
            lastSyncedHash: localHash,
            pendingPush: false,
            lastError: null,
            consented: true,
          });
          return;
        }
      }
      if (!this.#config.consented) {
        // Sync ships on, and the area is shared by every install on the
        // profile, so this device can meet a snapshot it never asked for.
        // Empty (a fresh install — the case the default exists for): adopt,
        // there is nothing to lose. Otherwise ask, and do nothing meanwhile.
        if (!this.#isPristine(local)) {
          this.needsConsent = true;
          return;
        }
        await this.#saveConfig({ consented: true });
      }
      if (wouldApply) {
        if (opts.allowApply) await this.#applyRemote(remote);
        // else: deferred — don't push over a newer remote either.
      } else {
        await this.#uploadLocal(local, localHash, fitted);
      }
    } catch (err) {
      // pendingPush stays set — retried on the next change, interval tick,
      // startup, or manual sync.
      await this.#saveConfig({ lastError: syncErrorMessage(err) });
      if (classifySyncError(err) === 'rate') this.#scheduleRetry(RATE_LIMIT_RETRY_MS);
    } finally {
      this.#syncing = false;
    }
  }

  /** Publishes local data to replace something unreadable or stale, under
   * the clock of its last sync or edit rather than now — it must not win
   * last-write-wins just for being written last — and flagged `repaired`,
   * so a device that synced something newer pushes that back instead of
   * applying this. */
  #reseed(local: Backup, hash: string) {
    local.exportedAt = Math.max(this.#config.lastSyncedAt, this.#config.lastChangedAt);
    return this.#fit(local, true).then((fitted) => this.#uploadLocal(local, hash, fitted));
  }

  async #uploadLocal(local: Backup, hash: string, fitted?: Fitted<EncodedBlob>) {
    fitted ??= await this.#fit(local);
    // Set before the write: the echo can arrive before `set` resolves.
    this.#lastBlobHash = fitted.payload.meta.hash;
    this.#writingRemote = true;
    try {
      await writeSyncArea(fitted.payload);
    } finally {
      // The last change event of the write is dispatched after the promise
      // settles; let it pass before listening again.
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.#writingRemote = false;
    }
    this.#lastPushAt = Date.now();
    this.usedBytes = itemsBytes(blobToItems(fitted.payload));
    await this.#saveConfig({
      lastSyncedAt: fitted.snapshot.exportedAt,
      lastSyncedHash: hash,
      pendingPush: false,
      lastError: null,
      trimmed: fitted.trimmed,
    });
  }

  /** Merges the remote snapshot into local data and reloads the panel
   * (mirrors the import flow — stores read storage once at startup). The hash
   * is taken from a re-read because the merge keeps local charts the remote
   * left out, so what landed in storage differs from the remote bytes. Those
   * charts are not pushed back on their own — that would ping-pong at the
   * budget edge; they ride along with the next real change. */
  async #applyRemote(remote: SyncSnapshot) {
    // #applying stays set: the page is about to reload, and nothing that
    // happens between apply and reload should schedule a push.
    this.#applying = true;
    clearTimeout(this.#pushTimer);
    try {
      await applySyncSnapshot(remote);
      const applied = await createBackup();
      await this.#saveConfig({
        lastSyncedAt: remote.exportedAt,
        lastSyncedHash: await snapshotHash(applied),
        pendingPush: false,
        lastError: null,
        consented: true,
      });
      // After the reload, reconcile sees remote.exportedAt === lastSyncedAt and
      // an unchanged hash — no loop.
      location.reload();
    } catch (err) {
      this.#applying = false;
      throw err;
    }
  }
}

export const sync = new SyncStore();
