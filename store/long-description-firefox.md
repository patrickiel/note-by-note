Note by Note turns any audio or video in your browser into a practice tool.

It opens in the sidebar and processes the page's audio in real time, so you can drop a song into your instrument's key, slow a solo to half speed without the chipmunk effect, and loop four bars until they stick. YouTube lessons, backing tracks, streamed albums, or an mp3 on your own disk — if it plays in the browser, you can practise along with it.

**Pitch and speed**

- Transpose ±12 semitones, or ±36 with extended range turned on. Speed is untouched.
- Fine-tune in cents, or pin playback to a reference pitch if you're playing with a group tuned to 415 Hz instead of 440.
- Speed runs from 25% to 200% and leaves pitch exactly where it is.
- Pitch shifting and time stretching come from the Rubber Band Library's realtime R3 engine, compiled to a WebAssembly AudioWorklet — the same algorithm used by desktop audio software.

**Practice structure**

- Drop markers on the timeline as you listen, and set a loop range between any two points.
- Click a marker tile to loop its section; drag across tiles, or shift-click a second one, to loop everything in between.
- Add a count-in so you're not scrambling on the downbeat of every repeat.
- Save any loop as a snippet, then chain snippets into a sequence: play the solo four times at 50%, then three times at 75%, then twice at full speed — without touching the panel between passes.

**Sound**

- A vocal reducer (STFT centre-cut, written for this project) pushes the centre-panned voice down so the band comes forward — or inverts it to isolate the vocal instead.
- A 10-band EQ with saveable presets, plus built-in curves that lean the mix toward guitar, bass, drums or vocals.

**Chords**

- Optional chord and key detection runs a machine-learning model over the audio, entirely on your machine, and draws a chart under the timeline.

**Keeping your place**

- Markers, loops, snippets and effect settings are saved per track against the page URL, so reopening a video brings your practice setup back with it.
- Favourites and recently practised tracks live in a library tab.
- Optional cross-device sync copies that setup to your other browsers.

**How it connects**

Nothing is requested when you install it. The first time you press Connect, the extension asks for site access once, rather than interrupting you on every new site. Settings → Revoke Permissions takes it back at any time.

Most pages attach directly: a Web Audio graph on the page's own audio or video element, with the full feature set. This is the YouTube path. A few pages block that — DRM-protected streams, cross-origin media, or a strict content-security policy — and the panel says so instead of half-working. Settings → Play local file opens a player for files on your disk, where nothing is restricted.

**Privacy**

- No telemetry. No analytics. No ads. No accounts. Nothing is sold or shared.
- Audio never leaves your device. Every effect — pitch, speed, vocal reduction, EQ, chord detection — runs locally in your browser.
- The extension makes no network requests. Cross-device sync goes through Firefox Sync (no server, no account with us); it is on by default, can be switched off in Settings, and carries no audio: just your settings, markers, loops, snippets, and the page URLs and titles of the tracks in your library.
- Full policy: [PRIVACY.md](https://github.com/patrickiel/note-by-note/blob/main/PRIVACY.md)

**Open source**

Note by Note is free software under the GPL-2.0-or-later. The complete source, including the audio engine, is at [github.com/patrickiel/note-by-note](https://github.com/patrickiel/note-by-note) — bug reports and contributions welcome.

Requires Firefox 140 or later. The sidebar is desktop-only, so Firefox for Android is not supported.
