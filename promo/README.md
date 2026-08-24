# promo

Assets for launch posts. `screencast.mp4` is the raw 89.6 s recording (2014×1510,
30 fps) — treat it as the master and never edit it in place.

The upload file is built in two passes, each writing a new mp4:

```
screencast.mp4  --apply-captions.ps1-->  screencast-captioned.mp4
                --apply-cards.ps1----->  screencast-promo.mp4   <- upload this
```

## Captions

Two files drive the captioned cut:

| File | What it is |
|------|-----------|
| [captions.srt](captions.srt) | The caption text and timings. **This is the only file you edit.** |
| [apply-captions.ps1](apply-captions.ps1) | Burns the SRT into `screencast-captioned.mp4`. |

`captions.srt` is plain SubRip — a number, a `hh:mm:ss,mmm --> hh:mm:ss,mmm`
range, then one or two lines of text. Note the **comma** before the milliseconds,
not a period; ffmpeg rejects the file otherwise. Keep it to two lines per cue.

### Fine-tuning loop

Timings first, styling second, full render last:

```powershell
# 1. Timings — no re-encode, ~2 s. Scrub screencast-captioned-soft.mp4 in VLC or
#    mpv with subtitles on, note where a cue lands early or late, edit the SRT.
.\promo\apply-captions.ps1 -Soft

# 2. Styling / copy in context — burns just a 12 s window to *-preview.mp4.
.\promo\apply-captions.ps1 -Preview 47 -Duration 12

# 3. Ship it.
.\promo\apply-captions.ps1
```

`-Preview` uses an output-side seek, so cues land exactly where the SRT says —
the window you render is real timeline time, not an offset.

### Knobs

`-FontSize` and `-MarginV` are in **output pixels** (defaults scale with the
frame: 9.5% and 5% of height). Also `-Box` for an opaque backing panel instead of
outline + shadow, `-Height 1080` to downscale, `-Font`, `-TextColor`,
`-ShadeColor`, `-Crf`. `Get-Help .\promo\apply-captions.ps1 -Full` has the rest.

The full render re-encodes at CRF 20, which takes the 189 MB master down to
~15 MB — comfortably inside every platform's upload limit.

### Gotcha

ffmpeg's SRT→ASS conversion hardcodes a 384×288 script resolution, so raw
`force_style` sizes are fractions of the frame, not pixels. The script converts
to ASS up front and rewrites `PlayResX/PlayResY` to the output size so the size
parameters mean what they say. It also reads that ASS back as UTF-8 explicitly —
Windows PowerShell would otherwise decode it as ANSI and turn every em dash into
mojibake.

## Bookend cards

[apply-cards.ps1](apply-cards.ps1) wraps the captioned cut in two animated
cards — a ~2.3 s title card in front and a ~3 s call to action at the end — and
writes `screencast-promo.mp4`:

```powershell
.\promo\apply-cards.ps1
```

| File | What it is |
| --- | --- |
| [card.css](card.css) | The shared skin: palette, 1007×755 layout box, hairline grid, loop-range motif, entrance keyframes. |
| [intro.html](intro.html) | Title card. Glyph, wordmark and tagline rise in on a stagger, then the loop range draws itself in from its left edge. |
| [outro.html](outro.html) | Closing card: *Free for your browser*, with a Chrome Web Store / Firefox Add-ons pill each. |

Palette and motifs come from the store tile
([store/tools/store-promo.html](../store/tools/store-promo.html)) so the video
and the listing read as one piece of design, and the note glyph is inlined from
[src/assets/icon.svg](../src/assets/icon.svg) — the app's own vector, sharp at
any size.

### How the animation gets into the video

[capture-card.mjs](capture-card.mjs) opens a card in headless Chrome
(puppeteer-core and the Chrome for Testing under `.browsers`, same as
`scripts/generate-icons.mjs`), **pauses every animation on the document and
steps `currentTime` one frame at a time**, screenshotting each position. So the
capture is deterministic — no real-time recording, no dropped frames, no
dependence on what the machine was doing. The CSS timeline in the card *is* the
video timeline.

Only the animated part is captured (`-Settle`, default 1.35 s = 41 frames,
~20 s of wall clock per card). ffmpeg's `tpad` clones the last frame for the
hold and the fade-out, so the still tail costs nothing. `-FadeIn` (0.35 s)
overlaps the entrances, so a card arrives rather than appearing and then
animating. `-Hold` (0.55 s) is the intro's pause; `-OutroHold` (1.2 s) is the
outro's, longer because that card has to be read.

The splice is a **stream copy**: the captioned footage is never re-encoded and
caption timings stay relative to their own footage, which is why the cards are a
separate pass rather than part of the caption render. They are therefore encoded
to match the screencast (probed fps, yuv420p, silent 48 kHz stereo AAC), and the
script re-probes the result and warns if the duration is not input + cards — the
usual symptom of a codec mismatch. One `Non-monotonic DTS` line at a junction is
expected and harmless.

Iterating on the art needs no video at all:

```powershell
.\promo\apply-cards.ps1 -CardsOnly    # ~6 s, writes promo/intro.png and promo/outro.png
```

Those PNGs are the settled cards, kept around as post thumbnails. Opening
either HTML file in a browser plays it at full speed.

### Gotcha

The concat list is written with `[IO.File]::WriteAllText`, not `Set-Content`:
Windows PowerShell's UTF8 encoding emits a BOM and ffmpeg reads it as part of
the first keyword (`unknown keyword '﻿file'`).

## Reddit

Post copy lives in [reddit/](reddit/). Upload `screencast-promo.mp4` as **native
Reddit video** — a YouTube link gets a fraction of the plays. Keep the original
audio audible; the pitch and speed changes are the demo.
