/**
 * Note by Note sync backend: a key-value store for backup snapshots, keyed by a
 * client-generated secret ID. The ID is the whole capability — anyone holding
 * it can read and write the blob — so CORS is open (`*`) and no other auth
 * exists. Deployed once by the developer; see ../README.md.
 *
 * Because the ID *is* the credential it is passed in the `X-Sync-Id` header,
 * never in the path or query: URLs are recorded verbatim by Workers Logs and
 * every other edge-side request log. For the same reason KV is keyed by
 * SHA-256(id) rather than the raw value, so a KV key listing discloses nothing
 * usable either.
 *
 * KV is eventually consistent (~60 s across edges); the extension self-heals
 * via periodic pulls, so no stronger consistency is needed here.
 */

interface Env {
  SYNC_KV: KVNamespace;
  /** Per-IP write limiter; see `ratelimits` in wrangler.jsonc. */
  SYNC_WRITE_LIMIT: RateLimit;
}

/** Matches the extension's generated IDs: 32 random bytes → 43-char base64url.
 * Anything shorter would be guessable, so it is rejected before touching KV. */
const ID_RE = /^[A-Za-z0-9_-]{43,64}$/;

const MAX_BODY_BYTES = 1024 * 1024;

/** Snapshots outlive any realistic gap between a user's sessions, but not
 * forever — an abandoned blob eventually ages out instead of costing storage
 * indefinitely. Refreshed on every write. The extension re-seeds an expired
 * blob automatically (see `#reconcile` in sync.svelte.ts). */
const TTL_SECONDS = 180 * 24 * 60 * 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Id',
  'Access-Control-Max-Age': '86400',
};

function respond(status: number, body: string | null, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...CORS_HEADERS, ...headers } });
}

/** KV key for a sync ID. Hex SHA-256 so the secret itself is never stored. */
async function kvKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return respond(204, null);

    if (new URL(request.url).pathname !== '/v1/backup') return respond(404, 'Not found');

    const id = request.headers.get('X-Sync-Id') ?? '';
    if (!ID_RE.test(id)) return respond(400, 'Invalid or missing sync ID');
    const key = await kvKey(id);

    if (request.method === 'GET') {
      let value: string | null;
      try {
        value = await env.SYNC_KV.get(key);
        // Pre-hashing deployments stored the blob under the raw ID. Fall back
        // once; the next PUT rewrites it under the hashed key.
        if (value === null) value = await env.SYNC_KV.get(id);
      } catch {
        return respond(502, 'Storage temporarily unavailable');
      }
      if (value === null) return respond(404, 'No data for this sync ID');
      return respond(200, value, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }

    if (request.method === 'PUT' || request.method === 'DELETE') {
      // Writes are the expensive, abusable direction. Reads are left alone so a
      // shared NAT can't lock its users out of pulling.
      const { success } = await env.SYNC_WRITE_LIMIT.limit({
        key: request.headers.get('cf-connecting-ip') ?? 'unknown',
      });
      if (!success) return respond(429, 'Too many requests', { 'Retry-After': '60' });
    }

    if (request.method === 'PUT') {
      // Reject early when the client declares an oversized body, before buffering.
      if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
        return respond(413, 'Snapshot too large');
      }
      const body = await request.text();
      // `body.length` counts UTF-16 units; the cap is bytes, so measure UTF-8.
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
        return respond(413, 'Snapshot too large');
      }
      // Sniff the payload so the namespace can't be used as a generic dump.
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return respond(400, 'Body is not valid JSON');
      }
      const record = parsed as Record<string, unknown> | null;
      if (
        record === null ||
        typeof record !== 'object' ||
        record.format !== 'note-by-note-backup' ||
        typeof record.exportedAt !== 'number'
      ) {
        return respond(400, 'Body is not a Note by Note backup');
      }
      try {
        await env.SYNC_KV.put(key, body, { expirationTtl: TTL_SECONDS });
      } catch {
        return respond(502, 'Storage temporarily unavailable');
      }
      return respond(204, null);
    }

    if (request.method === 'DELETE') {
      try {
        // Both keys: a blob written before the hashing change is still the
        // user's, and "delete my data" has to mean it.
        await Promise.all([env.SYNC_KV.delete(key), env.SYNC_KV.delete(id)]);
      } catch {
        return respond(502, 'Storage temporarily unavailable');
      }
      return respond(204, null);
    }

    return respond(405, 'Method not allowed', { Allow: 'GET, PUT, DELETE, OPTIONS' });
  },
};
