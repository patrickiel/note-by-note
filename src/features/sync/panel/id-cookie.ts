import { SYNC_ID_RE } from '../persist/sync-config';
import { SYNC_ENDPOINT, SYNC_ORIGIN_PATTERN } from '../endpoint';

/**
 * Durable copy of the sync ID — the canonical explanation; README, PRIVACY
 * and the Settings copy defer to this file.
 *
 * `storage.sync` carries the ID to the user's other devices, but the browser
 * purges it — on every device on the account — the moment the extension is
 * uninstalled, and a reinstall then mints a fresh ID with no way back to the
 * old snapshot. Cookies belong to the profile, not the extension, so one set on
 * the sync server's domain is the one store that outlives an uninstall. It is
 * read and written only through the `cookies` API and never rides along with a
 * request: the sync calls carry the ID in a header, and a cookie is meaningless
 * to the Worker anyway.
 *
 * The `cookies` API needs host access to the sync origin. That is an
 * *optional* host permission (a required one would disable the extension on
 * update until re-approved on Chrome, and is opt-in on Firefox regardless), so
 * everything here is best-effort until `requestIdCookieAccess` succeeded in a
 * user gesture — `<all_urls>` from Connect covers it too. `sync.durable`
 * mirrors that state so the panel never promises a copy it can't keep.
 *
 * Lifecycle: written whenever sync is on with an ID (the store's `#reflect`
 * is the single call site), removed by "Delete synced data" so a later
 * reinstall does not resurrect an identity the user abandoned. Clearing browser
 * cookies loses it — the panel keeps showing the ID for copying.
 */
const NAME = 'syncId';
/** Chromium caps cookie lifetime at 400 days; refreshed once per panel start. */
const MAX_AGE_S = 400 * 24 * 60 * 60;

export async function hasIdCookieAccess(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [SYNC_ORIGIN_PATTERN] });
  } catch {
    return false;
  }
}

/** Must run in a user gesture. Resolves true when access is held afterwards. */
export async function requestIdCookieAccess(): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: [SYNC_ORIGIN_PATTERN] });
  } catch {
    return false;
  }
}

export async function readIdCookie(): Promise<string | null> {
  try {
    const cookie = await browser.cookies.get({ url: SYNC_ENDPOINT, name: NAME });
    return cookie && SYNC_ID_RE.test(cookie.value) ? cookie.value : null;
  } catch {
    return null;
  }
}

/** Best-effort: a missing permission must not break sync itself. No `secure`
 * attribute — the cookie is never sent, and localhost in dev is plain http. */
export async function writeIdCookie(id: string): Promise<void> {
  try {
    await browser.cookies.set({
      url: SYNC_ENDPOINT,
      name: NAME,
      value: id,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Math.floor(Date.now() / 1000) + MAX_AGE_S,
    });
  } catch {
    // Unsupported or not permitted here — the sync area still has the ID.
  }
}

export async function removeIdCookie(): Promise<void> {
  try {
    await browser.cookies.remove({ url: SYNC_ENDPOINT, name: NAME });
  } catch {
    // Nothing to remove, or no access — either way there is no copy to keep.
  }
}
