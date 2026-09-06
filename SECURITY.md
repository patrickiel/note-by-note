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

The extension itself:

- Escaping the extension's boundaries — anything that lets a web page reach
  privileged extension APIs through the content script or the message port
- Anything that causes the extension to grant, keep, or widen host permissions
  beyond what the user approved
- Anything that lets a web page read or write the extension's storage,
  including the synced copy in the browser's `storage.sync` area
- Injection through data the extension stores and later renders — track titles,
  marker labels, thumbnail URLs, applied sync snapshots — and anything a
  crafted snapshot can make the extension do beyond overwriting practice data

## What is not a vulnerability

Two properties look like bugs but are the documented design. Reports of these
will be closed as working-as-intended:

- **Sync transport is the browser's.** There is no server of ours. Synced data
  travels through the browser vendor's extension sync (Google, Mozilla, or the
  Chromium vendor's), under their security model; see
  [PRIVACY.md](PRIVACY.md). Findings about that transport belong with the
  vendor.
- **Sync is last-write-wins.** Two devices editing at once means one loses.
  That is a data-loss property, not a security boundary; file it as a bug if
  you can trigger it in a way the design does not predict.

Also out of scope: anything that needs the user to already be running
attacker-controlled code locally, or another extension with storage access to
this one.
