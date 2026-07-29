# Store assets

Everything the Chrome Web Store and AMO listings need, produced once and reused
for both. See [PUBLISHING.md](../PUBLISHING.md) Step 3 for where each piece goes.

| File | Use |
| --- | --- |
| [icon-128.png](icon-128.png) | Store icon (copy of `public/icon/128.png`) |
| [short-description.txt](short-description.txt) | Chrome "Short description" (132 char cap) / AMO summary — 76 chars |
| [long-description.txt](long-description.txt) | Chrome "Detailed description". Plain text, no markup — the field renders line breaks but not Markdown |
| [long-description-firefox.md](long-description-firefox.md) | AMO "Description". Markdown (AMO supports bold/italic/links/lists, **but not headings**, so sections are bold lines). Also differs on substance: sidebar not side panel, no tab-capture fallback, Firefox 140+ |
| [privacy-policy-firefox.md](privacy-policy-firefox.md) | AMO "Privacy Policy" field, which takes text rather than a URL. [PRIVACY.md](../PRIVACY.md) reflowed into AMO's Markdown subset (no headings, no tables) and with the Chrome-only `tabCapture`/`offscreen` row dropped |
| [screenshots/](screenshots/) | Five 1280×800 PNGs. Chrome accepts at most five; AMO takes all of them |
| [promo-tile-440x280.png](promo-tile-440x280.png) | Chrome small promo tile (optional) |
| [promo-tile-1400x560.png](promo-tile-1400x560.png) | Chrome large promo tile / marquee (optional, only used for editorial featuring) |

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
left half is listing copy. `store-promo.html` draws the 440×280 tile standalone,
but its 1400×560 marquee (`?size=marquee`) docks the same live panel.

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
- `http://localhost:4321/store-promo?size=marquee` — same, in a window wider
  than 1400 px. Both `store-shot` and the marquee set `window.__ready` once the
  panel has settled; wait for it before capturing.

Chrome wants **24-bit PNG with no alpha** for screenshots and both tiles, and a
DevTools/Puppeteer element capture writes RGBA. Flatten afterwards:

```powershell
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($img, 0, 0, $img.Width, $img.Height); $g.Dispose()
$bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
```

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
