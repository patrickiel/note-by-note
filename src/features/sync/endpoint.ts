import { SYNC_ENDPOINT_DEV, SYNC_ENDPOINT_PROD, syncHostPattern } from './sync-hosts';

/** The Worker this build talks to: localhost in dev, the deployed one in prod.
 * CORS is open there, so the sync calls themselves need no host permission;
 * only the ID cookie does (see panel/id-cookie.ts). */
export const SYNC_ENDPOINT = import.meta.env.DEV ? SYNC_ENDPOINT_DEV : SYNC_ENDPOINT_PROD;

/** Optional host permission that lets the `cookies` API touch the sync host. */
export const SYNC_ORIGIN_PATTERN = syncHostPattern(SYNC_ENDPOINT);
