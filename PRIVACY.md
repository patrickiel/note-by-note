# Privacy Policy — Note by Note

**Last updated:** 5 September 2026
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

## What leaves your device, and when

The extension makes **no network requests of its own**. The one way data can
leave your device is the optional **cross-device sync**, which uses the
browser's own extension sync storage (`storage.sync`): the extension writes a
snapshot there, and the browser — not the extension — carries it to your other
devices signed in to the same browser profile.

Sync is **on by default**. When there is something to sync, the snapshot
contains:

- your settings and UI preferences
- your EQ presets
- your **Recent** and **Favorites** lists — including the **page URL and title**
  of tracks you practised
- your per-track data — markers and labels, loop ranges, snippets, chord charts

The snapshot is compressed and, when it would not fit the browser's sync quota,
trimmed by priority (chord charts and older Recent entries are left out first).
Nothing is deleted from your device by trimming.

Because that snapshot contains the addresses of pages you have visited, the
Firefox listing declares the `browsingActivity` data-collection category.

**Not included:** audio, page content, keystrokes, browsing history beyond the
tracks you practised on, or anything identifying you personally.

### Where it goes

Your browser vendor's sync service — Google for Chrome, Mozilla for Firefox, or
the vendor of a Chromium-based browser such as Edge or Brave — stores and
transports it under its own terms and privacy policy. The author operates no
server and cannot see the data.

- If you are not signed in to browser sync, the data never leaves the device.
- Firefox Sync is end-to-end encrypted. Chrome sync data is encrypted at rest
  by Google, and end-to-end only if you set a sync passphrase.
- There are no accounts with the extension and no sync ID.

### Turning it off and deleting the data

- `Settings → Sync` turns sync off. Nothing further is written to the browser's
  sync storage.
- `Settings → Sync → Delete synced data` clears the synced copy and turns sync
  off on that device. Another device with sync still on will upload its copy
  again, so turn it off there first if you want it gone.
- Uninstalling the extension removes the synced copy from the browser's sync
  storage on every device.

## Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Saves your markers, loops, snippets and settings on your device, and — with sync on — a copy in the browser's sync storage. |
| `activeTab`, `scripting` | Injects the audio engine into the tab when you press **Connect**. |
| `tabs` | Reads the active tab's URL and title to look up the practice data you saved for that track. |
| `tabCapture`, `offscreen` (Chrome only) | Fallback audio path for pages that block the audio worklet. |
| `identity` (Chrome only) | Asks the browser one yes/no question — is this profile signed in with sync on? — so `Settings → Sync` can warn when other devices won't be reached. No email, name or account details are read, and nothing is sent anywhere. |
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
