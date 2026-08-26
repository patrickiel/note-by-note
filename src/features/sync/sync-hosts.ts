/**
 * The sync Worker's addresses (see /server) — the single place they are
 * written down. Kept free of `import.meta.env` so wxt.config.ts can import it
 * at manifest-build time; `endpoint.ts` picks the one the bundle talks to.
 * Self-hosters change the production URL here and rebuild.
 */
export const SYNC_ENDPOINT_PROD = 'https://note-by-note-sync.oapp.workers.dev';
/** `cd server ; pnpm run dev` — the dev build targets this automatically. */
export const SYNC_ENDPOINT_DEV = 'http://localhost:8787';

/** Host match pattern for a Worker origin, as the manifest and the
 * `permissions` API want it. */
export function syncHostPattern(endpoint: string): string {
  return `${new URL(endpoint).origin}/*`;
}

/** Every pattern a build might hold for the sync host. The background worker
 * uses this to tell the sync host apart from sites the user granted. */
export const SYNC_HOST_PATTERNS: readonly string[] = [
  syncHostPattern(SYNC_ENDPOINT_PROD),
  syncHostPattern(SYNC_ENDPOINT_DEV),
];
