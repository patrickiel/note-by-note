<!-- Keep it focused. Linked issue, if there is one: Fixes #NNN -->

## What changes, and what a user notices

## How it was tested

<!-- CI runs check / test:dsp / build for you. Tick what you also ran locally. -->

- [ ] Tried it in a real browser (`pnpm dev`)
- [ ] `node e2e/run.mjs` — required if this touches the DSP or the connection
      state machine. The suite is not all-green (22/30); compare against a clean
      checkout rather than assuming your change caused a failure.
- [ ] Firefox, if the change is anything but panel-internal
- [ ] Worklet bundles rebuilt, if a `*.worklet.ts` or `center-cut-dsp.ts` changed

## Anything you are unsure about

<!-- By opening this PR you agree your work ships under GPL-2.0-or-later. -->
