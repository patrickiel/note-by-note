# Publishing

How to get Note by Note onto the Chrome Web Store and Firefox Add-ons (AMO).

Two builds, two stores, one source tree — [wxt.config.ts](wxt.config.ts) already
emits both. Work top to bottom: **Step 0 is the only part with open decisions**;
everything after it is mechanical.

---

## Step 0 — Settle these before uploading anything

| # | Decision | Why it blocks |
| --- | --- | --- |
| 0.1 | ~~Privacy policy URL~~ — **done** | [PRIVACY.md](PRIVACY.md). Both stores want a URL, so use `https://github.com/patrickiel/note-by-note/blob/main/PRIVACY.md` (or a GitHub Pages copy). Re-check the wording matches the shipped build before each submission. |
| 0.2 | ~~Firefox data-collection claim~~ — **done** | `data_collection_permissions` is now `{ required: ['browsingActivity'] }` — sync uploads Recent/Favorites, which carry page URLs and titles, and it is on by default. Answer the AMO data form the same way: *browsing activity*, required, no other categories. |
| 0.3 | ~~Version number~~ — **done** | `package.json` is `1.0.0`; WXT copies it into both manifests. Store versions can only ever go up and can't be reused, so a withdrawn or rejected `1.0.0` still burns the number — bump to `1.0.1` rather than resubmitting it. |
| 0.4 | **Who operates the sync Worker** | [PRIVACY.md](PRIVACY.md) names the author as operator and points at `note-by-note-sync.oapp.workers.dev`. If that changes, both the policy and `SYNC_ENDPOINT` in [api.ts](src/features/sync/panel/api.ts) have to change with it. |
| 0.5 | **GPL is fine here** | GPL-2.0-or-later is allowed on both stores. Only the Apple App Stores are off-limits (Rubber Band's own guidance) — irrelevant for browser extensions. |

---

## Step 1 — Prepare the release build

```powershell
pnpm install          # regenerates the worklet bundles — they are not committed
pnpm check            # type gate, must be clean
pnpm test:dsp
pnpm wxt build --mode testing ; node e2e/run.mjs   # optional but recommended
```

Then bump the version in [package.json](package.json) (WXT copies it into both
manifests), commit, and tag.

---

## Step 2 — Produce the store packages

```powershell
pnpm zip              # → .output/note-by-note-<version>-chrome.zip
pnpm zip:firefox      # → .output/note-by-note-<version>-firefox.zip
                      #   + note-by-note-<version>-sources.zip
```

Check before uploading:

- Both zips contain `worklets/rubberband-worklet.js`, `worklets/rb.wasm`,
  `worklets/vocal-reducer-worklet.js`, `worklets/pcm-tap-worklet.js`. If a
  worklet is missing, `pnpm install` was skipped.
- The Chrome zip has `offscreen.html`; the Firefox zip must **not** (that
  entrypoint is excluded from the Firefox build).
- Package is ~20 MB, mostly `models/btc.onnx` and the ONNX runtime WASM. Well
  under both stores' limits, but it makes review slower.

---

## Step 3 — Store assets (shared by both listings)

Produce these once, reuse for both stores:

- **Icon** — `public/icon/128.png` already exists.
- **Screenshots** — at least 3, `1280×800` (Chrome accepts `640×400` too; AMO is
  flexible). Good set: side panel next to a YouTube video, the timeline with
  markers and a loop range, the snippet chain, the EQ + vocal reducer.
- **Short description** — reuse the manifest line: *"Practice music with pitch,
  speed, loops, and snippets on any audio or video."* (Chrome caps at 132 chars.)
- **Long description** — adapt "What it does" from the README. State plainly:
  no telemetry, no analytics, sync is opt-out and carries no audio.
- **Promo tile** (Chrome, optional) — `440×280`.

---

## Step 4 — Chrome Web Store

1. Register at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) — **one-time $5 fee**, needs a Google account.
2. **New item** → upload `note-by-note-<version>-chrome.zip`.
3. Fill in the listing: description, category *Productivity*, screenshots, homepage `https://github.com/patrickiel/note-by-note`, privacy policy URL from Step 0.1.
4. **Privacy practices** — the part reviewers actually read. Justify each permission in one line:
   - `storage` — saves markers, loops and settings per track.
   - `activeTab` + `scripting` — injects the audio engine into the tab you press Connect on.
   - `tabs` — reads the active tab's URL/title to look up its saved practice data.
   - `tabCapture` + `offscreen` — fallback processing when a page blocks the audio worklet.
   - `optional_host_permissions: <all_urls>` — requested only on first Connect, never at install; needed because the user chooses which sites to practice on.
   - **Remote code**: answer *No*. All WASM ships inside the package; the CSP `wasm-unsafe-eval` is for instantiating those bundled bytes, not for fetching code.
   - **Data use**: declare *web history* for the sync feature (Recent/Favorites carry page URLs and titles) and check the three required "I do not sell / use only for the stated purpose / not for creditworthiness" boxes. Keep this consistent with the Firefox claim in Step 0.2.
5. Submit. First review typically takes a few days; `<all_urls>` and tab capture can push it longer.

---

## Step 5 — Firefox Add-ons (AMO)

1. Create a free account at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) — no fee.
2. **Submit a New Add-on** → *On this site* → upload `note-by-note-<version>-firefox.zip`.
3. **Upload the sources zip too.** This is mandatory, not optional: the build is bundled and minified, so review needs the source. Include build instructions in the notes-to-reviewer:
   ```
   Node 22+, pnpm 11.
   pnpm install ; pnpm zip:firefox
   Output: .output/note-by-note-<version>-firefox.zip
   Note: pnpm install (postinstall) generates the AudioWorklet bundles under
   public/worklets/ — they are intentionally not committed.
   ```
4. Confirm the manifest's `data_collection_permissions` matches what you answer in the data-collection form (Step 0.2) — a mismatch is a rejection.
5. Reuse the listing text and screenshots from Step 3. License: **GPL-2.0-or-later**.
6. Submit. AMO review is usually faster than Chrome's, but the source-code review of the WASM worklets may add a round trip.

---

## Step 6 — After both are live

1. Update the README's "Installing it" section — it currently says *"There's no store listing yet"*. Replace with the two store links.
2. Cut a GitHub release with the same tag and attach both zips (GPL source availability, and a fallback for anyone who wants to sideload).
3. Tick **Release** off [TODO.md](TODO.md).

---

## Updating later

Bump the version, rerun Steps 1–2, upload the new zip to each store. Chrome
auto-publishes after review; AMO signs and pushes the update. Every AMO upload
needs a fresh sources zip. Nothing else changes.
