# Technical post — r/chrome_extensions (Wave 1, day 1)

> Use the "Self Promotion" flair. Replace `[CHROME_WEB_STORE_LINK]`.

## Title (short personal options first)

Short & personal (preferred):

- The MV3 CSP/AudioWorklet dance cost me weeks — notes from shipping
- Real-time pitch shifting in an MV3 side panel, free and GPL

Longer personal:

- The CSP/AudioWorklet dance cost me weeks: notes from shipping real-time pitch shifting in an MV3 side panel (free, GPL)
- Things MV3 taught me the hard way while pitch-shifting YouTube in real time: no Blob worklets, one MediaElementSource per element, ever

Fallback:

- I built an MV3 side-panel extension that pitch-shifts any page's audio in real time (Rubber Band → WASM AudioWorklet). Free and GPL.

## Body

Note by Note is a music-practice extension: open the side panel on a YouTube lesson, transpose it into your key, slow it to half speed without the chipmunk effect, loop sections, chain practice snippets at increasing speeds. Free, open source, no accounts or telemetry.

Some of the MV3 problems that turned out to be interesting, in case anyone's building in this space:

- **The engine lives in the content script, not the panel.** The side panel is a thin mirror over a typed `chrome.runtime` Port, so closing the panel doesn't stop a running practice sequence.
- **AudioWorklets vs CSP.** Blob-URL worklets are blocked by extension CSP and by many sites, so the worklet processors ship as static files loaded from `chrome-extension://` URLs, and the WASM binary is fetched on the main thread and handed to the worklet via `processorOptions` — no fetch/eval inside the worklet.
- **Fallback chain.** Direct Web Audio attachment where possible; when the media element is CORS-tainted or DRM'd, it falls back to `tabCapture` processed in an offscreen document; local files get their own extension-page player where nothing is restricted.
- **Permissions.** Nothing at install; one optional-host-permission prompt from a user gesture on first Connect, revocable in settings.

Store: [CHROME_WEB_STORE_LINK]
Source: https://github.com/patrickiel/note-by-note

Happy to answer questions about any of it — the CSP/worklet dance especially cost me weeks.
