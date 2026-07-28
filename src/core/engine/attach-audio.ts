import { buildPipeline, type AudioPipeline } from '../audio/pipeline';
import { watchSilence } from '../audio/silence-detector';

export type AttachResult =
  | {
      ok: true;
      pipeline: AudioPipeline;
      stopWatchdog: () => void;
      /** Removes the document-level resume listeners (call on detach). */
      dispose: () => void;
    }
  | {
      ok: false;
      reason: 'cors' | 'drm' | 'already-captured' | 'worklet-failed';
      dispose?: () => void;
    };

/** Media elements can only ever be attached to one MediaElementSource — track
 * both the source and whether OUR pipeline still owns it. */
const attached = new WeakMap<
  HTMLMediaElement,
  { ctx: AudioContext; source: MediaElementAudioSourceNode }
>();

function corsPreflight(el: HTMLMediaElement): 'safe' | 'watchdog' | 'blocked' {
  // EME/DRM media: the processor can't read frames.
  if (el.mediaKeys) return 'blocked';
  const src = el.currentSrc || el.src;
  if (!src) return 'watchdog';
  // MSE / object / inline sources are never CORS-tainted.
  if (/^(blob|data|mediasource|filesystem):/.test(src)) return 'safe';
  try {
    if (new URL(src, location.href).origin === location.origin) return 'safe';
  } catch {
    return 'watchdog';
  }
  // Cross-origin: only safe when served with CORS *and* requested with it.
  return el.crossOrigin != null ? 'watchdog' : 'blocked';
}

/** Attaches the DSP pipeline to a media element, guarding against the
 * irreversible-mute failure modes (CORS taint, DRM, double-capture). */
export async function attachAudio(
  el: HTMLMediaElement,
  onCorsSilence: () => void,
): Promise<AttachResult> {
  const verdict = corsPreflight(el);
  if (verdict === 'blocked') {
    return { ok: false, reason: el.mediaKeys ? 'drm' : 'cors' };
  }

  let entry = attached.get(el);
  if (!entry) {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    let source: MediaElementAudioSourceNode;
    try {
      source = ctx.createMediaElementSource(el);
    } catch {
      // Another extension (or an old context) already owns the element.
      void ctx.close();
      return { ok: false, reason: 'already-captured' };
    }
    entry = { ctx, source };
    attached.set(el, entry);
  }

  const { ctx, source } = entry;

  // Autoplay policy: contexts start suspended until a gesture/play event.
  const resume = () => {
    if (ctx.state === 'suspended') void ctx.resume();
  };
  el.addEventListener('play', resume);
  document.addEventListener('pointerdown', resume, true);
  document.addEventListener('keydown', resume, true);
  resume();
  // The element 'play' listener stays for the element's lifetime: the context
  // keeps owning the element's audio even after detach, so it must remain
  // resumable. Only the document-level listeners (which stack per attach
  // cycle) are removed.
  const dispose = () => {
    document.removeEventListener('pointerdown', resume, true);
    document.removeEventListener('keydown', resume, true);
  };

  let pipeline: AudioPipeline;
  try {
    pipeline = await buildPipeline(ctx, source);
  } catch (err) {
    // Worklet/WASM blocked (page CSP or timeout). buildPipeline keeps its dry
    // route alive, so the element still plays — just unprocessed.
    console.warn('[note-by-note] pipeline unavailable:', err);
    return { ok: false, reason: 'worklet-failed', dispose };
  }

  const stopWatchdog =
    verdict === 'watchdog'
      ? watchSilence(pipeline.analyser, el, onCorsSilence)
      : () => {};

  return { ok: true, pipeline, stopWatchdog, dispose };
}
