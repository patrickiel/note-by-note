# Builder/OSS post — r/SideProject and r/opensource (Wave 1, day 1)

> Post to each on different days or reword between them; identical same-day cross-posts read as a campaign.
> Replace `[CHROME_WEB_STORE_LINK]`; attach screencast as native Reddit video.

## Title (short personal options first)

Short & personal (preferred):

- r/SideProject: A €4.99/month loop button radicalized me
- r/SideProject: One year, one WASM rabbit hole, one free practice tool
- r/opensource: A practice tool whose loop button can never be paywalled

Longer personal:

- r/SideProject: What started as "how hard can a loop button be" became a year of WASM AudioWorklets. My music-practice extension is finally on the Chrome store, free and GPL.
- r/SideProject: A €4.99/month loop button radicalized me. One year and one WebAssembly rabbit hole later: a free, GPL practice extension.
- r/opensource: The GPL is doing exactly its job here: a practice tool whose loop button can never go behind a paywall again

Fallbacks:

- r/SideProject: I was paying €5/month to set practice markers on YouTube videos. A year later I shipped a free open-source alternative.
- r/opensource: Note by Note — a GPL music-practice extension (real-time pitch shift via Rubber Band compiled to a WASM AudioWorklet)

## Body — short version (use this one)

I practice guitar along with YouTube lessons. My old tool put the practice features (markers, sequences, vocal reducer, EQ) behind €4.99/month, which bugged me enough to build my own. A year later: real-time pitch shift and time-stretch via the Rubber Band Library compiled to a WASM AudioWorklet, loops/markers/count-in, chainable practice snippets, a vocal reducer I wrote from scratch, 10-band EQ, and on-device chord detection, still in beta (a BTC/ONNX model drawing a chord chart under the timeline — something the paid tool doesn't offer at all).

It's GPL-2.0 — I like that the copyleft means nobody can fork it and paywall the loop button. No accounts, no telemetry; audio never leaves your machine. The optional sync server is a tiny Cloudflare Worker you can self-host.

Chrome Web Store: [CHROME_WEB_STORE_LINK] · Source: https://github.com/patrickiel/note-by-note

Happy to talk about the browser-DSP rabbit hole if anyone's curious.

## Body — extended version (fallback)

I practice guitar along with YouTube lessons, and my toolchain was the Transpose extension. The free tier covers pitch and speed, but the actual practice features — markers, clip sequences, saved setups, vocal reducer, EQ — are a €4.99/month subscription. Fair enough, it's their product, but it nagged me enough that I started building my own. That was about a year ago.

The hard part turned out to be real-time pitch shifting in a browser. The result runs the Rubber Band Library (the same time-stretch engine desktop DAWs license) as a WebAssembly AudioWorklet, attached directly to the page's media element — so YouTube, backing tracks, or a local mp3 all get the same DSP chain: pitch ±36 semitones, speed 25–200%, an STFT center-cut vocal reducer I wrote for the project, a 10-band EQ, and on-device chord detection with an ONNX model. When a page's CSP or DRM blocks direct attachment, it falls back to processing the tab's audio.

It's GPL-2.0-or-later (the copyleft comes from Rubber Band, and honestly I like that it means nobody can fork this and put the loop button behind a paywall). No accounts, no telemetry, no ads; the audio never leaves your machine. The one optional network feature — cross-device sync of your markers and settings — is a tiny Cloudflare Worker you can self-host.

Chrome Web Store: [CHROME_WEB_STORE_LINK]
Source (including the audio engine): https://github.com/patrickiel/note-by-note

Feedback very welcome — especially from anyone who's fought AudioWorklets and extension CSP, or who practices an instrument with YouTube.
