# Security Policy

## Supported versions

This is a single-developer project with no release branches. Only the latest
release, and `main`, receive fixes.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting:

→ [Report a vulnerability](https://github.com/patrickiel/note-by-note/security/advisories/new)

Include what you found, how to reproduce it, and what an attacker gets out of
it. A proof of concept helps. Expect a first reply within a week; this is a
side project, not a staffed product, so please size your expectations
accordingly. Once a fix ships you are welcome to disclose, and you will be
credited in the advisory unless you would rather not be.

## What is in scope

The extension itself, and the sync server under [`server/`](server/):

- Escaping the extension's boundaries — anything that lets a web page reach
  privileged extension APIs through the content script or the message port
- Anything that causes the extension to grant, keep, or widen host permissions
  beyond what the user approved
- Cross-user data access on the sync server, or anything that lets a snapshot
  be read or written without its sync ID
- Injection through data the extension stores and later renders — track titles,
  marker labels, thumbnail URLs, restored sync snapshots

## What is not a vulnerability

Two properties look like bugs but are the documented design. Reports of these
will be closed as working-as-intended:

- **The sync ID is the entire capability.** There are no accounts. Anyone
  holding the 43-character random ID can read and overwrite that snapshot, and
  the server has open CORS and no other authentication. This is deliberate —
  the ID is the secret, and the trade-off is spelled out in
  [PRIVACY.md](PRIVACY.md). Reports that it is guessable need to show it is
  actually guessable.
- **Sync is last-write-wins.** Two devices editing at once means one loses.
  That is a data-loss property, not a security boundary; file it as a bug if
  you can trigger it in a way the design does not predict.

Also out of scope: findings against `note-by-note-sync.oapp.workers.dev` that
require volumetric traffic, and anything that needs the user to already be
running attacker-controlled code locally.

## A note on scanning

Please do not run automated scanners or load tests against the hosted sync
Worker — it is a personal Cloudflare account. The server is small and
self-hostable ([`server/README.md`](server/README.md)); test against your own
deployment instead.
