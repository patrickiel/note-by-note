/** YouTube artwork is derivable from the page URL alone, so history entries
 * saved without a captured thumbnail still get one. */
export function youtubeThumbnailUrl(pageUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  let id: string | null = null;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.split('/')[1] || null;
  } else if (url.hostname.endsWith('youtube.com')) {
    id = url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : undefined;
}
