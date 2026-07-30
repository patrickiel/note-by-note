# Main post — r/guitarlessons (Wave 2, day 3–5)

> Verify the sidebar rules and flair on posting day; modmail first if unsure.
> Replace `[CHROME_WEB_STORE_LINK]` and attach the screencast as a **native Reddit video**.

## Title (pick one — short personal ones first)

Short & personal (preferred):

- A year of evenings later: my YouTube practice tool, free and open source
- I made the practice tool I didn't want to rent
- Loop four bars until they stick — free, open source, no catch
- My €5/month loop button is now free for everyone
- Free practice tool that also reads the chords off any YouTube video (beta)

Longer personal (the "I got tired of X, so I built Y" template is itself a Reddit cliché by now):

- My entire practice routine is looping four bars of a YouTube lesson until they stick. I spent a year building a free tool around exactly that habit.
- A year of evenings fighting WebAssembly later, the practice tool I always wanted for YouTube lessons exists — and it's free and GPL, forever
- I put every paid feature of my old practice extension into a free open-source one. Here's 75 seconds of it slowing down a solo.

Formula fallbacks:

- I got tired of paying a subscription for practice markers on YouTube videos, so I built a free open-source alternative
- The practice features I needed in Transpose were Pro-only, so I built a free open-source alternative

## Body — short version (use this one; the video carries the post)

For years my practice setup was YouTube + the Transpose extension. The basics are free there, but the actual practice features — markers, saved setups, sequences, vocal reducer, EQ — are €4.99/month. Fair enough, it's their product. But it bugged me enough that I spent the past year building my own, and I made it free and open source (GPL), permanently — nobody can ever put the loop button behind a paywall again.

The screencast shows most of it: transpose into your key, half speed without the chipmunk effect, markers and loops with a count-in, snippet chains (solo 4× at 50%, then 75%, then full speed, hands-free), vocal reducer, and EQ. And one thing my old tool doesn't do at any price: chord recognition (beta) — an ML model listens to the audio on your machine and draws the chord chart under the timeline. It's not always right yet, but it's often enough to get you playing along. Everything is saved per video. No accounts, no telemetry, no ads — audio never leaves your device.

Chrome-only for now (Firefox in review). Feedback from people who practice with YouTube lessons is exactly what I'm here for.

Chrome Web Store: [CHROME_WEB_STORE_LINK] · Source: https://github.com/patrickiel/note-by-note

## Body — extended version (fallback, if the sub skews text-heavy)

For a few years my practice setup was YouTube + the Transpose extension: drop a lesson into my key, slow the solo down, loop the hard part. The basics are free there, but everything that makes it a *practice* tool — markers, saved setups, clip sequences, vocal reducer, EQ — sits behind a €4.99/month subscription. Fair enough, it's their product. But setting markers on a YouTube video didn't feel like it should be a monthly bill.

So I built my own. It took a lot longer than I expected (real-time pitch shifting in a browser is... a rabbit hole), and at some point I decided that if I'm doing this, it should be free for everyone and open source, permanently — it's GPL, so nobody can take it and put the loop button behind a paywall again.

What it does, in one screencast: [video above]

- **Pitch & speed, independently** — transpose ±12 semitones (±36 if you're weird like that), speed 25–200%, no chipmunk. The pitch engine is Rubber Band, the same library desktop DAWs use, compiled to WebAssembly.
- **Loops, markers, and "snippets"** — drop markers as you listen, loop between any two, add a count-in. Save a loop as a snippet and chain them: solo 4× at 50%, then 3× at 75%, then full speed, hands-free.
- **Vocal reducer & 10-band EQ** — push the vocal down so the band comes forward, or lean the mix toward the guitar.
- **Chord detection** — an ML model runs over the audio *on your machine* and draws a chord chart under the timeline.
- **It remembers** — markers, loops and settings are saved per video, so reopening a lesson brings your setup back.

Privacy stuff, because extensions have a reputation: no accounts, no telemetry, no ads, audio never leaves your device. The whole thing including the audio engine is on GitHub.

It's Chrome-only for now (Firefox is in review). Would genuinely love feedback from people who practice with YouTube lessons — what's missing, what's broken, what's confusing.

Chrome Web Store: [CHROME_WEB_STORE_LINK] · Source: https://github.com/patrickiel/note-by-note
