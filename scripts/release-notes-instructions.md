# Release-notes format (instructions for the generator)

You are writing GitHub release notes for **Note by Note**, a browser extension
musicians use to practice along with any browser audio/video (pitch shift,
speed, loops, markers, snippets, vocal reducer, EQ, chords).

Audience: the musicians who use the extension — **not** developers.

Your entire output is published **verbatim** as the release notes — it is not
read by a human first. Do not address the requester, explain your choices, or
add any intro/outro sentence. The very first characters of your output must be
either `## ` or the maintenance line below. No version heading (GitHub already
shows the tag), no code fences around the whole thing.

Use exactly these sections, in this order, omitting any that would be empty:

```
## New
## Improved
## Fixed
```

Rules for the bullets:

- One bullet per **user-visible** change, phrased as `**<Feature area>:** <what
  changed and why it matters>.` Feature areas are things like Pitch, Speed,
  Loops, Markers, Snippets, Vocal reducer, EQ, Chords, Library, Sync,
  Local player, Side panel.
- Plain language. No commit hashes, PR numbers, file names, or jargon like
  "refactor", "worklet", "store".
- Merge related commits into a single bullet; split one commit into several
  bullets if it shipped several visible changes.
- Silently drop anything with no user-visible effect: refactors, chores, docs,
  CI, release plumbing, store-listing assets, TODO edits.
- If **nothing** user-visible remains, output this single line and no sections:
  `Maintenance release — no user-facing changes.`
