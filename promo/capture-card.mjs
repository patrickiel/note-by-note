/**
 * Renders one of the bookend cards — promo/intro.html or promo/outro.html — to
 * a numbered PNG sequence (or a single still), one file per video frame.
 *
 * A card's entrances are ordinary CSS animations. Rather than record in real
 * time — which drops frames and bakes in whatever the machine was doing — this
 * pauses every animation on the document and steps `currentTime` frame by
 * frame, screenshotting each position. The output is deterministic: the same
 * HTML always yields the same frames.
 *
 * Usage (apply-cards.ps1 drives it; run it by hand while iterating):
 *   node promo/capture-card.mjs --card outro --out <dir> --frames 41 --fps 30
 *   node promo/capture-card.mjs --card intro --still promo/intro.png
 */
import { globSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The card is laid out in a fixed CSS box; scale 2 lands it on the
// screencast's native 2014x1510.
const CARD = { width: 1007, height: 755, deviceScaleFactor: 2 };
// Past the last animation's end, so the still shows everything settled.
const SETTLED_MS = 5000;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const card = flag('card', 'intro');
const still = flag('still');
const outDir = flag('out');
const frames = Number(flag('frames', 41));
const fps = Number(flag('fps', 30));

if (!['intro', 'outro'].includes(card)) throw new Error(`Unknown card: ${card}`);
if (!still && !outDir) throw new Error('Pass --out <dir> or --still <file.png>.');
if (outDir) mkdirSync(outDir, { recursive: true });

const cardUrl = 'file:///' + resolve(root, 'promo', `${card}.html`).replace(/\\/g, '/');

// Same Chrome for Testing install the e2e harness and the icon generator use
// (install: pnpm dlx @puppeteer/browsers install chrome@stable --path ./.browsers),
// falling back to whatever puppeteer-core can find on PATH.
const chromePath =
  globSync(resolve(root, '.browsers', 'chrome', '*', 'chrome-win64', 'chrome.exe'))[0] ??
  process.env.CHROME_PATH;
if (!chromePath) {
  throw new Error(
    'No Chrome found. Run: pnpm dlx @puppeteer/browsers install chrome@stable --path ./.browsers',
  );
}

/** Freeze the document's animations at `ms` on their own timeline. */
const seek = (ms) =>
  document.getAnimations().forEach((a) => {
    a.pause();
    a.currentTime = ms;
  });

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport(CARD);
  await page.goto(cardUrl, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  if (still) {
    await page.evaluate(seek, SETTLED_MS);
    await page.screenshot({ path: resolve(root, still) });
    console.log(still);
  } else {
    // Fixed three-digit names starting at 000: apply-cards.ps1 feeds the
    // sequence to ffmpeg as %03d.png with -start_number 0.
    for (let i = 0; i < frames; i++) {
      await page.evaluate(seek, (i / fps) * 1000);
      await page.screenshot({ path: resolve(outDir, `${String(i).padStart(3, '0')}.png`) });
    }
    console.log(`${card}: ${frames} frames -> ${outDir}`);
  }
} finally {
  await browser.close();
}
