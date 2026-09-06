# Contributing

Thanks for looking. Issues and pull requests are welcome.

## Getting set up

```powershell
pnpm install   # not optional — see below
pnpm dev       # launches Chrome with the extension loaded, HMR on
```

Node 22+ and pnpm 11+. Development happens on Windows; nothing is deliberately
Windows-only except the e2e harness, which globs for `chrome-win64`.

**`pnpm install` is mandatory before anything audio-related works.** The three
AudioWorklet bundles under `public/worklets/` are generated, not committed —
`postinstall` copies the Rubber Band WASM, builds all three with esbuild, and
*then* runs `wxt prepare`. That order matters: `wxt prepare` derives the
`PublicPath` union from whatever is actually sitting in `public/`, so preparing
first leaves `browser.runtime.getURL('/worklets/…')` a type error in three
files.

## The gates

```powershell
pnpm check      # svelte-check / TypeScript — the only type or lint gate
pnpm test:dsp   # node --test, the DSP unit tests
pnpm build      # production build → .output/chrome-mv3
```

CI runs all three on every pull request, plus the Firefox build. Run them
locally first anyway; the
turnaround is much faster than waiting on a runner. (A first-time contributor's
workflow run needs a maintainer to click approve, so it may sit for a bit.)
There is no ESLint or Prettier config, deliberately — match the style of the
code around you.

For the browser-level e2e suite (it plays a 440 Hz tone and asserts on the
*processed* output), see the Tests section of [README.md](README.md).

## Things that will cost you an afternoon if you don't know them

- **Worklet edits don't hot-reload.** Changing a `src/features/*/engine/*.worklet.ts`
  or `center-cut-dsp.ts` mid-`pnpm dev` does nothing until you rerun the matching
  `scripts/build-*-worklet.mjs` or restart the dev server.
- **`@/` does not resolve everywhere.** The esbuild worklet bundles and the
  `node --test` files don't share the WXT/Vite resolver. Worklet sources use
  relative imports; test files use relative imports *with explicit `.ts`
  extensions*. (`import type` is erased, so type-only imports can omit it.)
- **`note-by-note-center-cut` is a string literal on both sides** of the worklet
  boundary — `vocal-reducer.worklet.ts` registers it, `vocal-reducer.ts`
  constructs it. `tsc` will not catch a mismatch; you get an `InvalidStateError`
  at runtime.
- **A media element can host exactly one `MediaElementSourceNode`** for the
  lifetime of the document. Reloading the extension therefore means reloading
  the page too.
- **The e2e suite is not currently all-green** — 22 of 30. The audio path passes
  end to end; the failures are in marker chips, loop and sequence bounds, the
  tab-capture CTA, and the vocal-reducer control. They pre-date any change you
  are about to make; compare against a clean checkout before assuming otherwise.

## Architecture in one paragraph

The audio engine lives in the page (content script), not in the side panel; the
panel is a thin mirror that talks to it over a typed `chrome.runtime` port. The
tree is organised in vertical feature slices under `src/features/<feature>/`,
each with an `engine/` (content script) and/or `panel/` (side panel) folder that
**never import from each other**. Composition roots import feature
contributions, never the reverse. [CLAUDE.md](CLAUDE.md) has the long version,
and it is accurate — start there before a non-trivial change.

## Pull requests

Keep them focused, explain the user-visible effect, and say how you tested. If a
change touches the DSP or the connection state machine, run the e2e suite and
say so — the unit tests only cover the signal-processing maths.

## Licence

By contributing you agree your work ships under GPL-2.0-or-later, like the rest
of the project. See [LICENSE](LICENSE).
