import { SYNC_ID_RE } from '../persist/sync-config';
import { SYNC_ENDPOINT } from './api';

/**
 * Durable copy of the sync ID.
 *
 * `storage.sync` carries the ID to the user's other devices, but the browser
 * purges it — on every device on the account — the moment the extension is
 * uninstalled, and a reinstall then mints a fresh ID with no way back to the
 * old snapshot. Cookies belong to the profile, not the extension, so one set on
 * the sync server's domain is the one store that outlives an uninstall. It is
 * read and written only through the `cookies` API and never rides along with a
 * request: the sync calls carry the ID in a header, and a cookie is meaningless
 * to the Worker anyway.
 */
const NAME = 'syncId';
/** Chromium caps cookie lifetime at 400 days; refreshed on every panel start. */
const MAX_AGE_S = 400 * 24 * 60 * 60;

export async function readIdCookie(): Promise<string | null> {
  try {
    const cookie = await browser.cookies.get({ url: SYNC_ENDPOINT, name: NAME });
    return cookie && SYNC_ID_RE.test(cookie.value) ? cookie.value : null;
  } catch {
    return null;
  }
}

/** Best-effort: a missing permission must not break sync itself. Never
 * removed — the ID is kept even after "Delete synced data", and the cookie is
 * only ever a way back to it. */
export async function writeIdCookie(id: string): Promise<void> {
  try {
    await browser.cookies.set({
      url: SYNC_ENDPOINT,
      name: NAME,
      value: id,
      // Localhost in dev is plain http, where a Secure cookie can't be set.
      secure: SYNC_ENDPOINT.startsWith('https:'),
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Math.floor(Date.now() / 1000) + MAX_AGE_S,
    });
  } catch {
    // Unsupported or not permitted here — the sync area still has the ID.
  }
}
