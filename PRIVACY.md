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

The extension makes **no network requests of its own**. The one thing that
leaves your device is the optional **cross-device sync** copy, and it leaves
through your browser's own sync (Chrome sync, Firefox Sync) — the same channel
that carries your bookmarks — to the other devices signed into the same
browser profile. If browser sync is off, nothing leaves the device.

Sync is **on by default**. When there is something to sync, it writes one
compact snapshot into the browser's synced extension storage containing:

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

Into your browser vendor's sync storage, under your browser account, subject to
that vendor's own data handling (Google for Chrome sync, Mozilla for Firefox
Sync — the latter end-to-end encrypted). The author operates no server and can
see none of it. There are no accounts with us and no sync ID.

The browser caps this storage at 100 KB per extension. The snapshot is stored
compact and compressed so a typical library fits with room to spare; when one
doesn't, the oldest songs and chord charts stay on the device that has them and
the Settings page says so.

### Turning it off and deleting the data

- `Settings → Sync` turns sync off on that device. No further data is written.
- `Settings → Sync → Delete synced data` empties the synced copy (other devices
  with sync still on will write theirs again).
- Uninstalling the extension makes the browser remove its synced storage.

## Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Saves your markers, loops, snippets and settings on your device, and — through the browser's synced storage — carries them to your other devices. |
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
