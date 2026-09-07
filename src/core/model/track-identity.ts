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

  const host = url.hostname.replace(/^www\./, '');

  // Site-aware rules: keep only the media id where we know it.
  if ((host === 'youtube.com' || host.endsWith('.youtube.com'))) {
    const v = url.searchParams.get('v');
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

/**
 * What makes a song itself: its normalized URL and its title, hashed. This is
 * `TrackIdentity.key` — the storage key of its track record, the id every
 * library list is matched on, and what a tombstone names. One key, so no two
 * parts of the app can disagree about what counts as the same song.
 *
 * **Duration is not in it.** It drifts — a pre-roll ad, metadata that settles
 * late — and a key that moved with it split one song across several records,
 * which every list then had to work around. Duration is metadata now: stored,
 * shown, and updated in place.
 *
 * The title is in it because the URL alone is not enough: every local file
 * reports the local-player page URL and is told apart only by its title, and
 * a page can hold more than one song.
 */
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
