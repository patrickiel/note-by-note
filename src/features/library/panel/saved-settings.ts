import type { HistoryEntry, TrackIdentity } from '../../../core/model/types';
import { favorites } from './favorites.svelte';
import { history } from './history.svelte';

/** The settings saved for a song that is being *visited* — a typed URL, a link,
 * an SPA navigation — or null when it has none.
 *
 * Deliberately looser than `isSameTrack`: at a page's first media event the
 * title has usually not settled (sites rewrite document.title after the element
 * fires), so demanding a title match would miss the very case this exists for.
 * The URL alone is not enough either — every local file reports the local-player
 * page URL and is told apart only by its title. So the title is required exactly
 * when the URL is ambiguous, i.e. when it holds more than one song. */
export function findSavedEntry(identity: TrackIdentity): HistoryEntry | null {
  // Favorites first: the two lists are written together and cannot disagree,
  // but with Auto Save off only the favorite is guaranteed to exist.
  const pool = [...favorites.entries, ...history.entries].filter(
    (e) => e.identity.normalizedUrl === identity.normalizedUrl,
  );
  const titled = pool.filter((e) => e.identity.title === identity.title);
  if (titled.length > 0) return titled[0];
  // Count songs, not rows — a favorited song is a row in both lists.
  const oneSong = new Set(pool.map((e) => e.identity.title)).size === 1;
  return oneSong ? pool[0] : null;
}
