# note-by-note-sync

Minimal Cloudflare Worker + KV backend for Note by Note device sync. Stores one
backup snapshot per secret sync ID. No accounts, no auth beyond the ID itself.

## API

One route, `/v1/backup`. The sync ID goes in an **`X-Sync-Id` header**, never in
the path or query — URLs are recorded verbatim by Workers Logs and every other
edge request log, and the ID is the whole credential.

- `GET /v1/backup` → the stored backup JSON, or `404` if the ID has no data.
- `PUT /v1/backup` → stores the request body (must be a Note by Note backup
  ≤ 1 MiB), `204`.
- `DELETE /v1/backup` → removes the snapshot, `204`.

IDs must match `[A-Za-z0-9_-]{43,64}`, matching what the extension generates
(32 random bytes as base64url). Shorter IDs are rejected: a hand-picked one
would be guessable, and guessing it is the whole attack.

KV is keyed by `SHA-256(id)`, so the raw token isn't stored either. `GET` falls
back to the raw-ID key once, for blobs written before that change; the next
`PUT` rewrites them under the hashed key.

Snapshots carry a 180-day TTL, refreshed on every write, so abandoned blobs age
out. The extension re-seeds an expired one automatically.

Writes (`PUT`/`DELETE`) are rate-limited per IP via the `SYNC_WRITE_LIMIT`
binding — 60/minute, far above a real client's 5-second push debounce, and
enough to make scripted abuse of the free KV write quota uninteresting. Reads
are not limited, so a shared NAT can't lock its users out of pulling.

Failures return a CORS-bearing `502` rather than letting the exception escape:
Cloudflare's own error page carries no CORS headers, which the browser reports
as a network failure indistinguishable from being offline.

> **Upgrading from the pre-header API:** the old `/v1/:id` route is gone, so
> deploy this Worker and the matching extension build together. An older
> extension against this Worker (or vice versa) gets a `404` on every call.

## Deploy (once)

```sh
pnpm install
pnpm wrangler kv namespace create SYNC_KV   # paste the id into wrangler.jsonc
pnpm run deploy
```

Then set the deployed URL as `SYNC_ENDPOINT` in `../src/features/sync/panel/api.ts` and rebuild the extension.

## Local development

```sh
pnpm run dev   # serves http://localhost:8787 with a local KV emulation
```

The extension's dev build (`pnpm dev` at the repo root) targets `http://localhost:8787` automatically.
