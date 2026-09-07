import { DEFAULT_PARAMS } from '../model/defaults';
import { makeTrackIdentity } from '../model/track-identity';
import type { EffectParams, HistoryEntry, MediaInfo, TrackIdentity } from '../model/types';
import type { Practice } from '../persist/library';
import { editLibrary, readLibrary } from '../persist/library-client';
import { openTabWithPanel } from '../side-panel';
import { session } from './session.svelte';
import { settings } from '../../features/settings/panel/settings.svelte';
import { markers } from '../../features/markers/panel/markers.svelte';
import { snippets } from '../../features/snippets/panel/snippets.svelte';
import { chords } from '../../features/chords/panel/chords.svelte';

/** An active session loads saved data once. Library updates never interrupt playback. */
class TrackSync {
  #identity: TrackIdentity | null = null;
  #media: MediaInfo | null = null;
  #generation = 0;
  #restoring = false;
  #hasSavedParams = false;
  #chordsEnabled = false;
  /** Parameter changes arrive per input event while a slider is dragged, and
   * every save rewrites the whole library. Coalesce them into one write. */
  #paramsTimer: ReturnType<typeof setTimeout> | undefined;

  init() {
    markers.onPersist = (list) => this.#save({ markers: list });
    snippets.onPersist = () => this.#save({ snippets: $state.snapshot(snippets.list),
      sequenceLoop: snippets.sequenceLoop, sequenceCountIn: snippets.sequenceCountIn });
    chords.onPersist = () => {
      if (!this.#identity || this.#restoring) return;
      // Generated analysis is local and does not date the saved practice record.
      void editLibrary({ type: 'chart', key: this.#identity.key, chart: $state.snapshot(chords.chart) });
      if (this.#chordsEnabled !== chords.enabled) {
        this.#chordsEnabled = chords.enabled;
        this.#save({ chordsEnabled: chords.enabled });
      }
    };
  }

  onEngineLost() {
    this.#flushParams();
    this.#generation++;
    this.#identity = null;
    this.#media = null;
  }

  async onMedia(media: MediaInfo | null) {
    // Null media is a transient engine state (detecting, no player, mid source
    // change), not the end of the session — dropping the track here would throw
    // away edits made before the next event. Real loss arrives via `onEngineLost`.
    if (!media) return;
    const identity = makeTrackIdentity(media.pageUrl, media.title, media.duration);
    if (this.#identity?.key === identity.key) { this.#media = media; this.#identity = identity; return; }
    // Flushed against the outgoing track's media: `#save` reads `#media` for the
    // saved pageUrl and thumbnail, so replacing it first files this song's URL
    // under the previous song's identity.
    this.#flushParams();
    this.#media = media;
    this.#identity = identity;
    this.#hasSavedParams = false;
    const generation = ++this.#generation;
    // Saving is closed for the whole load, not just the apply: the stores still
    // hold the previous song, and `#identity` already names this one, so any
    // edit landing inside the await would write that song's markers, snippets
    // and parameters onto this one.
    this.#restoring = true;
    try {
      const saved = await readLibrary();
      if (generation !== this.#generation) return;
      const practice = saved.shared.songs[identity.key]?.practice;
      this.#hasSavedParams = !!practice?.params;
      markers.load(practice?.markers ?? []);
      snippets.load(practice?.snippets ?? [], practice?.sequenceLoop ?? false, practice?.sequenceCountIn ?? false);
      chords.load(saved.local.charts[identity.key] ?? null, practice?.chordsEnabled);
      this.#chordsEnabled = chords.enabled;
      const params = practice?.params ?? (settings.current.autoReset ? DEFAULT_PARAMS :
        settings.current.rememberSettings ? settings.current.lastUsedParams : undefined);
      // $state.snapshot, not structuredClone: `settings.current` is a rune, so
      // `lastUsedParams` is a proxy and structuredClone throws on it.
      if (params) session.patchParams($state.snapshot(params) as EffectParams);
    } finally {
      // A newer track already owns the flag; only its own load may clear it.
      if (generation === this.#generation) this.#restoring = false;
    }
    if (generation !== this.#generation) return;
    await editLibrary({ type: 'visit', key: identity.key });
  }

  onParamsChanged() {
    if (this.#restoring) return;
    clearTimeout(this.#paramsTimer);
    this.#paramsTimer = setTimeout(() => this.#flushParams(), 1500);
  }

  /** Writes the parameters a drag settled on. Also called before the track
   * changes, so the last edit is never lost to the pending timer. */
  #flushParams() {
    if (this.#paramsTimer === undefined) return;
    clearTimeout(this.#paramsTimer);
    this.#paramsTimer = undefined;
    if (this.#restoring) return;
    const params = $state.snapshot(session.params) as EffectParams;
    this.#save({ params });
    if (settings.current.rememberSettings) void editLibrary({ type: 'settings', patch: { lastUsedParams: params } });
  }

  #save(patch: Partial<Practice>) {
    if (!this.#identity || this.#restoring) return;
    if (!this.#hasSavedParams) patch = { params: $state.snapshot(session.params), ...patch };
    this.#hasSavedParams = true;
    void editLibrary({ type: 'practice', identity: this.#identity,
      patch: { ...patch, pageUrl: this.#media?.pageUrl ?? this.#identity.normalizedUrl,
        thumbnailUrl: this.#media?.thumbnailUrl }, recent: settings.current.autoSave,
    }).catch((error) => console.error('[note-by-note] saving practice failed', error));
  }

  async openHistoryEntry(tabId: number | null, entry: HistoryEntry) {
    const playing = this.#identity?.key;
    if (playing === entry.identity.key) {
      // Explicitly opening the saved song adopts its current library revision.
      this.#flushParams();
      this.#identity = null;
      await this.onMedia(this.#media);
      return;
    }
    if (tabId != null) await browser.tabs.update(tabId, { url: entry.pageUrl });
    else await openTabWithPanel(entry.pageUrl);
  }
}
export const trackSync = new TrackSync();
