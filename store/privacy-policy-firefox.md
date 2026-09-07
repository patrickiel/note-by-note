Note by Note is a browser extension for practising music along with audio and video you already have open. There are no accounts, no advertising, no analytics, and no telemetry of any kind. Nothing is sold or shared with third parties.

**Audio is never transmitted**

All audio processing — pitch shift, time stretch, vocal reduction, EQ, chord detection — happens locally, inside your browser, using Web Audio and WebAssembly that ships with the extension. **No audio ever leaves your device**, and no audio is recorded or stored.

**What is stored on your device**

Everything the extension remembers is kept in browser extension storage on your computer:

- Settings and UI preferences
- Effect parameters (pitch, speed, loops, EQ presets)
- Per-track data: markers and their labels, loop ranges, practice snippets, and cached chord charts
- **Recent** and **Favorites**: for each track you practised, its page URL, page title, media duration and thumbnail URL

Uninstalling the extension removes all of it. Settings → Reset Settings clears it without uninstalling.

**What is transmitted, and when**

The extension makes no network requests of its own. The one thing that leaves your device is the optional cross-device sync copy, and it leaves through Firefox Sync — the same channel that carries your bookmarks — to the other devices signed into the same Firefox account. If Firefox Sync is off, nothing leaves the device.

Sync is on by default. It writes independent compressed records containing settings, EQ presets, saved songs (including URLs, titles, durations and thumbnail URLs), favorites and manual order, practice parameters, markers, labels and snippets. Recent activity, UI layout, last-used parameters and generated chord analysis stay on the device and are included in manual backup exports.

Because that data contains the addresses of pages you have visited, this listing declares the `browsingActivity` data-collection category.

Not included: audio, page content, keystrokes, browsing history beyond the tracks you practised on, or anything identifying you personally.

**Where it goes**

Into Firefox Sync's storage under your Firefox account, end-to-end encrypted, subject to Mozilla's own data handling. The author operates no server and can see none of it. There are no accounts with us and no sync ID.

Firefox caps synced storage at 100 KB per extension and 8 KB per item. If a compressed record or the library exceeds those limits, Settings reports an error. All data remains saved locally; no songs are automatically trimmed.

**Turning it off and deleting the data**

- Settings → Sync turns sync off on that device. No further data is written.
- Settings → Sync → Delete synced data empties the synced copy (other devices with sync still on will write theirs again).
- Uninstalling the extension makes Firefox remove its synced storage.

**Permissions and why**

- `storage` — saves your markers, loops, snippets and settings on your device.
- `alarms` ? retries background sync while the panel is closed.
- `activeTab`, `scripting` — injects the audio engine into the tab when you press Connect.
- `tabs` — reads the active tab's URL and title to look up the practice data you saved for that track.
- Access to all sites (optional) — requested **only** when you first press Connect, never at install time, because you choose which sites to practise on. Settings → Revoke Permissions takes it back.

**Children**

The extension is not directed at children and collects no information about anyone's identity or age.

**Changes**

Material changes to this policy will be recorded in the repository's commit history. The canonical copy is [PRIVACY.md](https://github.com/patrickiel/note-by-note/blob/main/PRIVACY.md).

**Contact**

Questions or requests: open an issue at [github.com/patrickiel/note-by-note/issues](https://github.com/patrickiel/note-by-note/issues).

Last updated: 7 September 2026. Operator: Patrick Demichiel.
