# Publishing

How to ship a new version of Note by Note to the Chrome Web Store and Firefox
Add-ons (AMO). First-time setup (accounts, listings, store assets, privacy
forms) is done — this is the recurring path.

## 1 — Cut the release

```powershell
pnpm release:dry      # preview: version bump, tag, steps
pnpm release          # check + test, bump patch, build zips, commit, tag, push
```

Non-patch bump: `.\scripts\release.ps1 -Bump minor` (or `-Bump major`,
`-Version x.y.z`). The script refuses on a dirty tree, off-`main`, behind
`origin/main`, or an existing tag. Output lands in `.output/`:

- `note-by-note-<version>-chrome.zip`
- `note-by-note-<version>-firefox.zip` + `note-by-note-<version>-sources.zip`

The script also creates the **GitHub release** (`gh release create` with all
three zips attached — GPL source availability + sideload fallback). The notes
are written by `claude -p` from the commit log, following the fixed format in
[scripts/release-notes-instructions.md](scripts/release-notes-instructions.md)
(auto-notes fallback if that fails). If only that step failed, run it manually:

```powershell
gh release create v<version> --generate-notes .output\*<version>*.zip
```

Optional pre-flight before releasing: `pnpm wxt build --mode testing ; node e2e/run.mjs`.

Sanity-check the zips if anything about the build changed:

- Both contain `worklets/rubberband-worklet.js`, `rb.wasm`,
  `vocal-reducer-worklet.js`, `pcm-tap-worklet.js` (missing → `pnpm install` was skipped).
- Chrome zip has `offscreen.html`; the Firefox zip must **not**.

## 2 — Chrome Web Store

[Developer Dashboard](https://chrome.google.com/webstore/devconsole) → the item
→ **Package** → upload the chrome zip → submit. Chrome auto-publishes after
review (a few days; `<all_urls>` + tab capture can stretch it).

Only revisit the **Privacy practices** tab if permissions or data use changed —
keep it consistent with the manifest's `data_collection_permissions`
(*browsing activity*: sync writes Recent/Favorites, which carry URLs/titles, to
the browser's sync storage).

## 3 — Firefox Add-ons (AMO)

[Developer Hub](https://addons.mozilla.org/en-US/developers/addon/note-by-note/edit) → **Upload
New Version** → upload the firefox zip **and the sources zip** (mandatory every
upload — the build is bundled/minified). Notes to reviewer:

```
Node 22+, pnpm 11.
pnpm install ; pnpm zip:firefox
Output: .output/note-by-note-<version>-firefox.zip
Note: pnpm install (postinstall) generates the AudioWorklet bundles under
public/worklets/ — they are intentionally not committed.

The validator's two warnings are both in third-party code:
- chunks/ort.wasm.bundle.min-*.js "unsafe call to import" — onnxruntime-web
  loading its own wasm glue by variable URL. It resolves to a bundled asset;
  nothing is fetched from the network (no CDN references in the package).
- chunks/settings.svelte-*.js "unsafe assignment to innerHTML" — the Svelte 5
  runtime's <template> helper, on compile-time-constant markup, via its
  "svelte-trusted-html" Trusted Types policy. Our own source contains no
  innerHTML and no {@html}.
```

If the data-collection answers ever change, the manifest's
`data_collection_permissions` and the AMO form must match — a mismatch is a
rejection.

## When listing content changes

Store copy and screenshots live in [store/](store/) and are shared by both
listings — see [store/README.md](store/README.md) for regeneration and upload
order. Chrome and Firefox long descriptions differ deliberately (markup,
sidebar vs side panel, no tab-capture paragraph on Firefox) — keep them in
sync when editing. Privacy policy is [PRIVACY.md](PRIVACY.md); re-check its
wording against the shipped build whenever behavior around data changes.
