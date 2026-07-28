# Store assets

Everything the Chrome Web Store and AMO listings need, produced once and reused
for both. See [PUBLISHING.md](../PUBLISHING.md) Step 3 for where each piece goes.

| File | Use |
| --- | --- |
| [icon-128.png](icon-128.png) | Store icon (copy of `public/icon/128.png`) |
| [short-description.txt](short-description.txt) | Chrome "Short description" (132 char cap) / AMO summary — 76 chars |
| [long-description.txt](long-description.txt) | Chrome "Detailed description" / AMO description. Plain text, no markup: both fields render line breaks but not Markdown |
| [screenshots/](screenshots/) | Five 1280×800 PNGs. Chrome accepts at most five; AMO takes all of them |
| [promo-tile-440x280.png](promo-tile-440x280.png) | Chrome small promo tile (optional) |

Screenshot order is the order they should be uploaded in — the first one is the
listing's hero:

1. `1-overview.png` — the panel docked beside the page, pitch/speed/vocals/EQ
2. `2-loops-markers.png` — timeline with labelled markers and a loop range
3. `3-snippet-chain.png` — the slow → fast snippet sequence
4. `4-vocal-reducer-eq.png` — vocal reducer and the 10-band EQ
5. `5-privacy-sync.png` — Settings: sync, data controls, no telemetry

## Regenerating them

The screenshots are the **real side panel**, not a mockup: `store-shot.html`
iframes `sidepanel.html?mock=1` at its native 400 px width and drives it into
the state each shot is about (scrolling to a section, opening Settings). The
left half is listing copy. `store-promo.html` is standalone.

Both pages have to be served from the same origin as the panel, so they are
copied into the build output rather than served from here:

```powershell
pnpm build
Copy-Item store\tools\*.html .output\chrome-mv3\
pnpm dlx serve .output/chrome-mv3 -l 4321 --no-clipboard
```

Then, in a browser window sized to exactly 1280×800, capture:

- `http://localhost:4321/store-shot?s=1` … `?s=5`
- `http://localhost:4321/store-promo` (capture the `.tile` element, not the
  viewport — Chrome will not shrink a window below ~500 px wide)

Use the extensionless URLs. `serve` redirects `/store-shot.html?s=2` to
`/store-shot` and **drops the query string**, which silently gives you shot 1
five times.

Stop `serve` before the next `pnpm build` — it holds the output directory open
and the build fails with `EBUSY`.

`store-shot.html` also carries the alternates each shot was chosen from:
`?s=1&v=b|c|d` swaps the lower-left block for stat tiles, shortcut chips or a
loop ribbon (`v=a`, bullets only, is what shipped). `store-promo?v=a|c|d` does
the same for the tile (`v=b`, centred, is what shipped).

The demo data — labelled markers, the loop range, the snippet chain, the Guitar
EQ curve, the chord chart — comes from `installMockState()` in
[src/dev/mock.ts](../src/dev/mock.ts). Change it there and rebuild; nothing in
these pages fakes product UI.
