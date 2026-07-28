/** Finds and ranks media elements on the page and watches for changes
 * (new players, SPA source swaps). Runs in the content script. */

export type MediaFoundCallback = (element: HTMLMediaElement) => void;
export type MediaLostCallback = (element: HTMLMediaElement) => void;

function collectMediaElements(root: ParentNode = document): HTMLMediaElement[] {
  const found = [...root.querySelectorAll<HTMLMediaElement>('video, audio')];
  // Include same-document shadow roots we can reach (open shadow DOM).
  for (const host of root.querySelectorAll<HTMLElement>('*')) {
    if (host.shadowRoot) found.push(...collectMediaElements(host.shadowRoot));
  }
  return found;
}

function score(el: HTMLMediaElement): number {
  let s = 0;
  if (!el.paused && !el.ended) s += 1000;
  if (Number.isFinite(el.duration) && el.duration > 0) s += 100;
  if (el.currentSrc) s += 50;
  if (el instanceof HTMLVideoElement) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 100) s += 25;
  }
  if (Number.isFinite(el.duration)) s += Math.min(el.duration / 60, 20);
  return s;
}

export function findBestMedia(): HTMLMediaElement | null {
  const all = collectMediaElements().filter(
    (el) => el.currentSrc || el.querySelector('source'),
  );
  if (!all.length) return null;
  return all.sort((a, b) => score(b) - score(a))[0];
}

/** Watches the page for media appearing/starting. `onCandidate` fires whenever
 * a (possibly better) element shows up or starts playing. */
export function watchForMedia(onCandidate: () => void): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (
          node instanceof HTMLMediaElement ||
          (node instanceof Element && node.querySelector?.('video, audio'))
        ) {
          onCandidate();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Media events don't bubble but can be captured at the document root — this
  // catches playback starting on elements that existed before injection and
  // inside open shadow roots.
  const onPlay = () => onCandidate();
  document.addEventListener('play', onPlay, true);
  document.addEventListener('durationchange', onPlay, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('play', onPlay, true);
    document.removeEventListener('durationchange', onPlay, true);
  };
}

/** Fires when the element's source is swapped out (SPA navigation on YouTube
 * & co.) — the moment to re-identify the track. */
export function watchSourceChange(
  el: HTMLMediaElement,
  onChange: () => void,
): () => void {
  const handler = () => onChange();
  el.addEventListener('emptied', handler);
  el.addEventListener('loadstart', handler);
  return () => {
    el.removeEventListener('emptied', handler);
    el.removeEventListener('loadstart', handler);
  };
}
