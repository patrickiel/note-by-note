import { clampSpeed, DEFAULT_PARAMS } from '../model/defaults';
import { youtubeThumbnailUrl } from '../model/thumbnail';
import type { EffectParams, MediaInfo } from '../model/types';

/** Element with the (widely supported, sometimes untyped) preservesPitch flag. */
type PitchedMediaElement = HTMLMediaElement & { preservesPitch?: boolean };

export interface MediaEngineEvents {
  onTime(t: number, playing: boolean): void;
  onMediaInfo(info: MediaInfo): void;
  onParams(params: EffectParams): void;
  onVolume(volume: number): void;
}

/** Effect-chain seam: the DSP pipeline implements this; when absent, volume
 * falls back to the element and non-speed params are display-only. */
export interface EffectChain {
  applyParams(params: EffectParams): void;
  setVolume(volume: number): void;
  setLowLatency(on: boolean): void;
  setFormantPreserved(on: boolean): void;
  dispose(): void;
}

const TIME_EMIT_MS = 33;

/** Controls one HTMLMediaElement: transport, rate/pitch flags, scrub preview,
 * playhead emission. The loop and sequence schedulers hook into `onTick`. */
export class MediaEngine {
  readonly el: PitchedMediaElement;
  params: EffectParams = structuredClone(DEFAULT_PARAMS);
  volume = 1;
  chain: EffectChain | null = null;
  /** Element-volume fallback is only safe once the DSP chain is confirmed
   * unavailable — a value written while the chain is still loading would keep
   * attenuating the element underneath the chain's gain afterwards. */
  allowElementVolume = false;
  /** Extra per-frame hook used by the loop/sequence schedulers. */
  onTick: ((t: number) => void) | null = null;

  #events: MediaEngineEvents;
  #lastEmit = 0;
  #rafId = 0;
  #intervalId: ReturnType<typeof setInterval> | undefined;
  #scrubTimer: ReturnType<typeof setTimeout> | undefined;
  #previewing = false;
  #scrubPlayPending = false;
  #volumeTouched = false;
  /** Rate we last wrote; null = hands-off, the page owns the rate. */
  #writtenRate: number | null = null;
  /** Last rate the page chose itself — restored when we disengage. */
  #pageRate: number;
  #disposers: (() => void)[] = [];

  constructor(el: HTMLMediaElement, events: MediaEngineEvents) {
    this.el = el;
    this.#events = events;
    this.#pageRate = el.playbackRate;

    const listen = (name: string, fn: () => void) => {
      el.addEventListener(name, fn);
      this.#disposers.push(() => el.removeEventListener(name, fn));
    };

    listen('play', () => {
      // A play we didn't initiate ends a pending scrub preview — otherwise the
      // preview timer would pause and yank back playback the user just started.
      if (this.#scrubPlayPending) this.#scrubPlayPending = false;
      else this.cancelScrub();
      this.#startTicking();
      this.#emitTime(true);
    });
    listen('pause', () => {
      this.#stopTicking();
      this.#emitTime(true);
    });
    listen('seeked', () => this.#emitTime(true));
    listen('ratechange', () => this.#onRateChange());
    listen('durationchange', () => this.emitMediaInfo());
    listen('timeupdate', () => this.#emitTime(false));

    // SPA navigations (YouTube) update document.title after the media element
    // fires its events — without this the panel keys the track under the
    // previous page's title and never hears the correction.
    const titleEl = document.querySelector('title');
    if (titleEl) {
      const observer = new MutationObserver(() => this.emitMediaInfo());
      observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
      this.#disposers.push(() => observer.disconnect());
    }

    this.#syncRateFlags();
    if (!el.paused) this.#startTicking();
  }

  get playing(): boolean {
    return !this.el.paused && !this.el.ended;
  }

  get t(): number {
    return this.el.currentTime;
  }

  get duration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  mediaInfo(): MediaInfo {
    return {
      title: document.title,
      pageUrl: location.href,
      duration: this.duration,
      hasVideo: this.el instanceof HTMLVideoElement,
      thumbnailUrl: this.#thumbnailUrl(),
    };
  }

  /** Best-effort artwork for the History list. */
  #thumbnailUrl(): string | undefined {
    // YouTube: derive from the video id — og:image goes stale on SPA navigation.
    const yt = youtubeThumbnailUrl(location.href);
    if (yt) return yt;
    if (this.el instanceof HTMLVideoElement && this.el.poster) return this.el.poster;
    const og = document.querySelector<HTMLMetaElement>('meta[property="og:image"]');
    return og?.content || undefined;
  }

  emitMediaInfo() {
    this.#events.onMediaInfo(this.mediaInfo());
  }

  // ─── Transport ───────────────────────────────────────────────

  play() {
    this.cancelScrub();
    void this.el.play().catch(() => {
      // Autoplay policy; the user can press play in the page player instead.
    });
  }

  pause() {
    this.cancelScrub();
    this.el.pause();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    // A bare seek during a preview restores the pre-preview paused state —
    // the preview's pause-back timer is gone, so nothing else would.
    this.cancelScrub(true);
    this.#seekRaw(t);
  }

  #seekRaw(t: number) {
    const el = this.el;
    // Never seek a source without metadata: the browser stashes the position
    // and jumps once metadata arrives — a mid-initialization seek is exactly
    // what wedges SPA players (YouTube SABR starves in a stuck Seeking state).
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const seekable = el.seekable;
    if (seekable.length > 0) {
      t = Math.max(seekable.start(0), Math.min(seekable.end(seekable.length - 1), t));
    } else if (this.duration > 0) {
      t = Math.min(this.duration, t);
    }
    el.currentTime = Math.max(0, t);
  }

  skip(seconds: number) {
    this.seek(this.el.currentTime + seconds);
  }

  jumpStart() {
    this.seek(0);
  }

  /** Scrub preview: while paused, play a short blip at the target time. */
  scrub(t: number, previewMs: number) {
    const realPlayback = this.playing && !this.#previewing;
    clearTimeout(this.#scrubTimer);
    this.#seekRaw(t);
    if (realPlayback) {
      this.#previewing = false;
      return;
    }
    if (!this.playing) {
      this.#scrubPlayPending = true;
      void this.el.play().catch(() => {
        this.#scrubPlayPending = false;
      });
    }
    this.#previewing = true;
    // Re-armed with the latest target on every call, so a drag ends the
    // preview where the pointer is — not snapped back to where it started.
    this.#scrubTimer = setTimeout(() => {
      this.#previewing = false;
      this.el.pause();
      this.#seekRaw(t);
    }, previewMs);
  }

  /** Drops a pending preview snap-back; called by every external transport
   * action and on source swaps so a stale timer can't pause the next track.
   * `restorePause` re-pauses a running preview (it started from paused, and
   * its pause-back timer is being cancelled). */
  cancelScrub(restorePause = false) {
    clearTimeout(this.#scrubTimer);
    this.#scrubPlayPending = false;
    if (this.#previewing && restorePause && !this.el.paused) this.el.pause();
    this.#previewing = false;
  }

  // ─── Params / volume ─────────────────────────────────────────

  patchParams(patch: Partial<EffectParams>) {
    Object.assign(this.params, patch);
    if (patch.speed !== undefined) {
      this.params.speed = clampSpeed(this.params.speed);
    }
    this.#syncRateFlags();
    this.chain?.applyParams(this.params);
    this.#events.onParams(this.params);
  }

  setVolume(volume: number) {
    this.#volumeTouched = true;
    this.volume = volume;
    if (this.chain) this.chain.setVolume(volume);
    else if (this.allowElementVolume) this.el.volume = volume;
    this.#events.onVolume(volume);
  }

  /** Applies a volume the user staged while the chain was still loading —
   * without touching the page's own volume when the user never set one. */
  flushVolume() {
    if (this.#volumeTouched) this.setVolume(this.volume);
  }

  #onRateChange() {
    const rate = this.el.playbackRate;
    // A rate we didn't write is the page's own choice — adopt it as the
    // baseline to restore later instead of fighting the page's player.
    if (this.#writtenRate === null || Math.abs(rate - this.#writtenRate) > 0.001) {
      this.#pageRate = rate;
    }
    this.#syncRateFlags();
  }

  #syncRateFlags() {
    // Hands-off unless speed is actively engaged: the page's player owns
    // playbackRate otherwise, and reverting its writes (ads, speed menu,
    // SPA transitions) destabilizes its streaming state machine.
    const engaged =
      this.params.power &&
      this.params.speedEnabled &&
      Math.abs(this.params.speed - 1) > 0.001;
    if (engaged) {
      // Speed change keeps pitch native (the stretch worklet handles pitch).
      this.el.preservesPitch = true;
      if (Math.abs(this.el.playbackRate - this.params.speed) > 0.001) {
        this.el.playbackRate = this.params.speed;
      }
      this.#writtenRate = this.params.speed;
    } else if (this.#writtenRate !== null) {
      // Disengaging: hand the element back at the page's own rate.
      this.#writtenRate = null;
      this.el.preservesPitch = true;
      if (Math.abs(this.el.playbackRate - this.#pageRate) > 0.001) {
        this.el.playbackRate = this.#pageRate;
      }
    }
  }

  // ─── Playhead ────────────────────────────────────────────────

  #startTicking() {
    this.#stopTicking();
    const raf = () => {
      this.#tick();
      this.#rafId = requestAnimationFrame(raf);
    };
    this.#rafId = requestAnimationFrame(raf);
    // rAF halts in background tabs; audible tabs keep ~1s timers, which the
    // audio-clock in the loop scheduler compensates for.
    this.#intervalId = setInterval(() => this.#tick(), 250);
  }

  #stopTicking() {
    cancelAnimationFrame(this.#rafId);
    clearInterval(this.#intervalId);
  }

  #tick() {
    this.onTick?.(this.el.currentTime);
    this.#emitTime(false);
  }

  #emitTime(force: boolean) {
    const now = performance.now();
    if (!force && now - this.#lastEmit < TIME_EMIT_MS) return;
    this.#lastEmit = now;
    this.#events.onTime(this.el.currentTime, this.playing);
  }

  dispose() {
    this.#stopTicking();
    this.cancelScrub();
    // Hand the element back at the page's own rate — otherwise the leftover
    // rate survives detach and the next engine instance adopts it as the
    // page's choice (video stuck fast/slow with the UI showing 100%).
    if (this.#writtenRate !== null) {
      this.#writtenRate = null;
      this.el.preservesPitch = true;
      if (Math.abs(this.el.playbackRate - this.#pageRate) > 0.001) {
        this.el.playbackRate = this.#pageRate;
      }
    }
    for (const dispose of this.#disposers) dispose();
    this.#disposers = [];
    this.chain?.dispose();
    this.chain = null;
  }
}
