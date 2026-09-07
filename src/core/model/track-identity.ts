import type { TrackIdentity } from './types';

/** Query params that never identify the media. */
const STRIP_PARAMS = new Set(['t', 'start', 'feature', 'si', 'pp', 'ab_channel', 'index']);

function normalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') {
    return `${url.protocol}//${url.host}${url.pathname}`;
  }

  const host = url.hostname.replace(/^www\./, '');

  // Site-aware rules: keep only the media id where we know it.
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const v = url.searchParams.get('v') ?? /^\/(?:shorts|embed)\/([^/]+)/.exec(url.pathname)?.[1];
    if (v) return `https://youtube.com/watch?v=${v}`;
    // Shorts / embeds carry the id in the path.
    return `https://youtube.com${url.pathname}`;
  }
  if (host === 'youtu.be') {
    return `https://youtube.com/watch?v=${url.pathname.slice(1)}`;
  }

  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (STRIP_PARAMS.has(key) || key.startsWith('utm_')) continue;
    params.append(key, value);
  }
  params.sort();
  const query = params.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/** Sites append their own name to document.title (e.g. " - YouTube"). */
export function cleanTitle(title: string): string {
  return title.replace(/\s+-\s+YouTube\s*$/, '');
}

/** Small stable string hash (djb2, hex). */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** Web media use a stable URL/provider ID; title and duration are metadata.
 * Local files retain the existing filename discriminator. */
export function songKey(identity: Pick<TrackIdentity, 'normalizedUrl' | 'title'>): string {
  const url = identity.normalizedUrl;
  if (url.startsWith('https://youtube.com/watch?v=')) return 'yt:' + url.slice('https://youtube.com/watch?v='.length);
  // Local-player URLs include a browser-specific extension ID. The file name
  // is the existing local-file discriminator; it must work across installations.
  if (/^(chrome|moz)-extension:/.test(url)) return 'file:' + hash(cleanTitle(identity.title));
  return 'web:' + hash(url);
}

/** Whether two library rows describe the same song. */
export function isSameTrack(a: TrackIdentity, b: TrackIdentity): boolean {
  return a.key === b.key;
}

export function makeTrackIdentity(
  pageUrl: string,
  title: string,
  durationSec: number,
): TrackIdentity {
  const normalizedUrl = normalizeUrl(pageUrl);
  const cleaned = cleanTitle(title);
  return {
    key: songKey({ normalizedUrl, title: cleaned }),
    normalizedUrl,
    title: cleaned,
    durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : 0,
  };
}
