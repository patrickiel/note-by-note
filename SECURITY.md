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
- Injection through data the extension stores and later renders — track titles,
  marker labels, thumbnail URLs, restored sync snapshots

## What is not a vulnerability

Two properties look like bugs but are the documented design. Reports of these
will be closed as working-as-intended:

- **Sync trusts the browser profile.** There is no server and no credential of
  ours: the synced copy lives in the browser's own synced extension storage,
  so whoever can sign into the browser profile can read and change it — the
  same boundary as the bookmarks. The trade-off is spelled out in
  [PRIVACY.md](PRIVACY.md).
- **Sync merges by recency.** Two devices editing the same song at once means
  the later edit wins that song. That is a data-loss property, not a security
  boundary; file it as a bug if you can trigger it in a way the design does
  not predict.

Also out of scope: anything that needs the user to already be running
attacker-controlled code locally.
