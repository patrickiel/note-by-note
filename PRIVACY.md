# Privacy Policy — Note by Note

**Last updated:** 28 July 2026
**Operator:** Patrick Demichiel ([github.com/patrickiel/note-by-note](https://github.com/patrickiel/note-by-note))

Note by Note is a browser extension for practising music along with audio and
video you already have open. There are no accounts, no advertising, no
analytics, and no telemetry of any kind. Nothing is sold or shared with third
parties.

## Audio is never transmitted

All audio processing — pitch shift, time stretch, vocal reduction, EQ, chord
detection — happens locally, inside your browser, using Web Audio and WebAssembly
that ships with the extension. **No audio ever leaves your device**, and no audio
is recorded or stored.

## What is stored on your device

Everything the extension remembers is kept in browser extension storage on your
computer:

- Settings and UI preferences
- Effect parameters (pitch, speed, loops, EQ presets)
- Per-track data: markers and their labels, loop ranges, practice snippets, and
  cached chord charts
- **Recent** and **Favorites**: for each track you practised, its page URL, page
  title, media duration and thumbnail URL

Uninstalling the extension removes all of it. `Settings → Reset Settings` clears
it without uninstalling.

## What is transmitted, and when

The extension makes exactly one kind of network request: the optional
**cross-device sync** backup. Nothing else in the extension talks to the network.

Sync is **on by default**, but it only starts transmitting once you have
something to sync. When it does, it uploads a single snapshot containing:

- your settings and UI preferences
- your EQ presets
- your **Recent** and **Favorites** lists — including the **page URL and title**
  of tracks you practised
- your per-track data — markers and labels, loop ranges, snippets, chord charts

Because that snapshot contains the addresses of pages you have visited, the
Firefox listing declares the `browsingActivity` data-collection category.

**Not included:** audio, page content, keystrokes, browsing history beyond the
tracks you practised on, or anything identifying you personally.

### Where it goes

Snapshots are stored by a Cloudflare Worker with Cloudflare KV, at
`https://note-by-note-sync.oapp.workers.dev`, operated by the author. The server
source is in [`server/`](server/) and can be self-hosted — self-hosters change
one constant and rebuild.

- There are no accounts. A random 43-character **sync ID** is the only
  credential; it *is* the capability, so treat it like a password.
- The ID travels in an `X-Sync-Id` header, never in the URL, so it does not land
  in request logs. KV is keyed by its SHA-256, so the raw ID is not stored either.
- Snapshots are stored **unencrypted**. Whoever operates the server can read
  them. Run your own if that matters to you.
- Snapshots expire after **180 days**, refreshed on every write.
- IP addresses are visible to Cloudflare as part of serving and rate-limiting
  requests, per Cloudflare's own data handling. They are not stored by the
  Worker or linked to a snapshot.

### Turning it off and deleting the data

- `Settings → Sync` turns sync off. No further data is transmitted.
- `Settings → Sync → Delete synced data` removes the server-side copy.
- Doing nothing also works: an unused snapshot expires after 180 days.

## Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Saves your markers, loops, snippets and settings on your device. |
| `activeTab`, `scripting` | Injects the audio engine into the tab when you press **Connect**. |
| `tabs` | Reads the active tab's URL and title to look up the practice data you saved for that track. |
| `tabCapture`, `offscreen` (Chrome only) | Fallback audio path for pages that block the audio worklet. |
| Access to all sites (optional) | Requested **only** when you first press **Connect**, never at install time, because you choose which sites to practise on. `Settings → Revoke Permissions` takes it back. |

## Children

The extension is not directed at children and collects no information about
anyone's identity or age.

## Changes

Material changes to this policy will be recorded in the repository's commit
history, and the date at the top of this file updated.

## Contact

Questions or requests: open an issue at
[github.com/patrickiel/note-by-note/issues](https://github.com/patrickiel/note-by-note/issues).
