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
  if (host.endsWith('youtube.com')) {
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

/** Whether two library rows describe the same song. Deliberately not a `key`
 * comparison: the duration baked into `key` drifts (pre-roll ads, metadata that
 * settles late), which would split one song across several Recent rows. The
 * title is what keeps local files apart — they all share the local-player URL. */
export function isSameTrack(a: TrackIdentity, b: TrackIdentity): boolean {
  return a.normalizedUrl === b.normalizedUrl && a.title === b.title;
}

/** The storage key of a track: `${hash(normalizedUrl)}:${durationSec}`, with
 * `durationSec` already rounded. Exported so a compact backup can leave the key
 * out and rebuild it from the two strings it stores anyway (backup-codec.ts). */
export function identityKey(normalizedUrl: string, durationSec: number): string {
  return `${hash(normalizedUrl)}:${durationSec}`;
}

/** A short handle for what `isSameTrack` compares — URL and title, no
 * duration — so a record about "this song" (a sync deletion, say) reaches
 * every copy of it however its duration drifted. */
export function songKey(identity: Pick<TrackIdentity, 'normalizedUrl' | 'title'>): string {
  return hash(`${identity.normalizedUrl}\n${identity.title}`);
}

export function makeTrackIdentity(
  pageUrl: string,
  title: string,
  durationSec: number,
): TrackIdentity {
  const normalizedUrl = normalizeUrl(pageUrl);
  const duration = Number.isFinite(durationSec) ? Math.round(durationSec) : 0;
  return {
    key: identityKey(normalizedUrl, duration),
    normalizedUrl,
    title: cleanTitle(title),
    durationSec: duration,
  };
}
