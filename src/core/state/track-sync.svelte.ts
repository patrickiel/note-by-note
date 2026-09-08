import { DEFAULT_PARAMS } from '../model/defaults';
import { makeTrackIdentity } from '../model/track-identity';
import type { EffectParams, HistoryEntry, MediaInfo, TrackIdentity } from '../model/types';
import type { Library, LibraryCommand, Practice } from '../persist/library';
import { editLibrary, libraryItem } from '../persist/library-client';
import { openTabWithPanel } from '../side-panel';
import { session } from './session.svelte';
import { settings } from '../../features/settings/panel/settings.svelte';
import { markers } from '../../features/markers/panel/markers.svelte';
import { snippets } from '../../features/snippets/panel/snippets.svelte';
import { chords } from '../../features/chords/panel/chords.svelte';
import { library } from './library.svelte';

type PracticeEdit = Extract<LibraryCommand, { type: 'practice' }>;
type RememberedParams = { params: EffectParams; importRevision: number };

/** An active session loads saved data once. Library updates never interrupt playback. */
class TrackSync {
  #identity: TrackIdentity | null = null;
  #media: MediaInfo | null = null;
  #baselineParams: EffectParams | null = null;
  #chordsEnabled = false;
  #importRevision = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: PracticeEdit | undefined;
  #rememberParams: RememberedParams | undefined;
  #lastUsed: RememberedParams | undefined;
  /** Edits stay available for A -> B -> A until the storage watch acknowledges
   * their commit. Only unacknowledged patches are overlaid on the library. */
  #drafts = new Map<string, { patch: Partial<Practice>; committedAt?: number }>();

  init() {
    this.#importRevision = library.current.local.importRevision ?? 0;
    libraryItem.watch((value) => {
      if (!value) return;
      this.#acknowledge(value);
      const revision = value.local.importRevision ?? 0;
      if (revision === this.#importRevision) return;
      this.#importRevision = revision;
      // Imports replace the session too. Discard pending pre-import edits;
      // the writer rejects old revisions already in flight.
      this.#cancelPending();
      this.#drafts.clear();
      this.#lastUsed = undefined;
      this.#identity = null;
      session.stopSequence();
      session.clearLoop();
      // Use the event's snapshot, independently of storage-listener ordering.
      void this.onMedia(this.#media, value).catch((error) => console.error('[note-by-note] loading imported practice failed', error));
    });
    markers.onPersist = (list) => this.#queue({ markers: list });
    snippets.onPersist = () => this.#queue({ snippets: $state.snapshot(snippets.list),
      sequenceLoop: snippets.sequenceLoop, sequenceCountIn: snippets.sequenceCountIn });
    chords.onPersist = () => {
      if (!this.#identity) return;
      // Generated analysis is local and does not date the saved practice record.
      void editLibrary({ type: 'chart', key: this.#identity.key, chart: $state.snapshot(chords.chart),
        importRevision: this.#importRevision }).catch((error) => console.error('[note-by-note] saving chart failed', error));
      if (this.#chordsEnabled !== chords.enabled) {
        this.#chordsEnabled = chords.enabled;
        this.#queue({ chordsEnabled: chords.enabled });
      }
    };
  }

  onEngineLost() {
    this.#flush();
    this.#identity = null;
    this.#media = null;
    this.#baselineParams = null;
  }

  /** Commit before the panel is hidden or its document is closed. */
  flush() { this.#flush(); }

  async onMedia(media: MediaInfo | null, saved = library.current) {
    // Null is transient (detecting / source change). Real loss has its own hook.
    if (!media) return;
    const identity = makeTrackIdentity(media.pageUrl, media.title, media.duration);
    if (this.#identity?.key === identity.key) { this.#media = media; this.#identity = identity; return; }
    this.#flush();
    this.#identity = null;
    this.#media = media;
    this.#baselineParams = null;
    this.#importRevision = saved.local.importRevision ?? 0;
    // Hydration is synchronous: no worker read can leave the previous song's
    // stores attached to a new identity. Restoration never emits user edits.
    try {
      const practice = { ...saved.shared.songs[identity.key]?.practice, ...this.#drafts.get(identity.key)?.patch };
      markers.load($state.snapshot(practice.markers ?? []));
      snippets.load($state.snapshot(practice.snippets ?? []), practice.sequenceLoop ?? false, practice.sequenceCountIn ?? false);
      chords.load($state.snapshot(saved.local.charts[identity.key] ?? null), practice.chordsEnabled);
      this.#chordsEnabled = chords.enabled;
      const params = practice.params ?? (saved.shared.settings.autoReset ? DEFAULT_PARAMS :
        saved.shared.settings.rememberSettings ? this.#lastUsed?.params ?? saved.local.lastUsedParams : undefined);
      if (params) session.restoreParams($state.snapshot(params) as EffectParams);
      this.#baselineParams = $state.snapshot(session.params) as EffectParams;
      this.#identity = identity;
    } catch (error) {
      markers.load([]);
      snippets.load([], false, false);
      chords.load(null, false);
      throw error;
    }
    await editLibrary({ type: 'visit', key: identity.key });
  }

  onParamsChanged() {
    const params = $state.snapshot(session.params) as EffectParams;
    this.#rememberParams = settings.current.rememberSettings ? { params, importRevision: this.#importRevision } : undefined;
    if (this.#rememberParams) this.#lastUsed = this.#rememberParams;
    if (this.#identity) {
      this.#baselineParams = params;
      this.#queue({ params });
    } else if (this.#rememberParams) {
      // Remember parameter edits made before a player is connected too.
      this.#schedule();
    }
  }

  #queue(patch: Partial<Practice>) {
    if (!this.#identity || !this.#baselineParams) return;
    const key = this.#identity.key;
    const draft = this.#drafts.get(key);
    if (!library.current.shared.songs[key]?.practice.params && !draft?.patch.params) {
      patch = { params: this.#baselineParams, ...patch };
    }
    // Capture values now, including the URL and revision. Engine echoes and
    // navigation cannot change what a delayed save writes.
    this.#pending = $state.snapshot({ type: 'practice', identity: this.#identity,
      importRevision: this.#importRevision, recent: settings.current.autoSave,
      patch: { ...this.#pending?.patch, ...patch,
        pageUrl: this.#media?.pageUrl ?? this.#identity.normalizedUrl, thumbnailUrl: this.#media?.thumbnailUrl },
    }) as PracticeEdit;
    this.#drafts.set(key, { patch: { ...draft?.patch, ...this.#pending.patch } });
    this.#schedule();
  }

  #schedule() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#flush(), 1500);
  }

  #cancelPending() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = undefined;
    this.#rememberParams = undefined;
  }

  #flush() {
    const command = this.#pending;
    const params = this.#rememberParams;
    this.#cancelPending();
    if (command) {
      const draft = this.#drafts.get(command.identity.key)!;
      void editLibrary(command).then((committedAt) => {
        draft.committedAt = committedAt;
        this.#acknowledge(library.current);
      }).catch((error) => {
        if (this.#drafts.get(command.identity.key) === draft) this.#drafts.delete(command.identity.key);
        console.error('[note-by-note] saving practice failed', error);
      });
    }
    if (params) void editLibrary({ type: 'settings', patch: { lastUsedParams: params.params },
      importRevision: params.importRevision }).then(() => this.#acknowledge(library.current)).catch((error) => {
        if (this.#lastUsed === params) this.#lastUsed = undefined;
        console.error('[note-by-note] saving last-used settings failed', error);
      });
  }

  #acknowledge(saved: Library) {
    if (this.#lastUsed && JSON.stringify(saved.local.lastUsedParams) === JSON.stringify(this.#lastUsed.params)) this.#lastUsed = undefined;
    for (const [key, draft] of this.#drafts) {
      if (draft.committedAt !== undefined && saved.shared.updatedAt >= draft.committedAt) this.#drafts.delete(key);
    }
  }

  async openHistoryEntry(tabId: number | null, entry: HistoryEntry) {
    const playing = this.#identity?.key;
    if (playing?.startsWith('file:') && entry.identity.key.startsWith('file:') && playing !== entry.identity.key) {
      // Preserve actual edits to A before previewing B's preset on its player.
      // File objects cannot be restored from a saved URL.
      this.#flush();
      session.restoreParams($state.snapshot(entry.params) as EffectParams);
      return;
    }
    if (playing === entry.identity.key) {
      this.#flush();
      this.#identity = null;
      await this.onMedia(this.#media);
      return;
    }
    const url = entry.identity.key.startsWith('file:') ? browser.runtime.getURL('/local-player.html') : entry.pageUrl;
    if (tabId != null) await browser.tabs.update(tabId, { url });
    else await openTabWithPanel(url);
  }
}
export const trackSync = new TrackSync();
