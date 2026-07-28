/**
 * Renders src/assets/icon.svg to the public/icon/*.png sizes the manifest
 * uses. Uses the same Chrome for Testing install as the e2e harness
 * (install: pnpm dlx @puppeteer/browsers install chrome@stable --path ./.browsers).
 *
 * Run: node scripts/generate-icons.mjs
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The committed amber accent (--accent in src/assets/theme.css): saturated
// enough to read on a dark toolbar, dark enough to read on a white one.
const COLOR = '#e5a83e';
const SIZES = [16, 32, 48, 96, 128];
// Square crop around the glyph's bounding box (x 6..19, y 4..21 in the 24
// viewBox) so the icon renders full-bleed in the toolbar instead of keeping
// the source SVG's inline-UI padding.
const VIEWBOX = '4 4 17 17';

const chromePath = globSync(
  resolve(root, '.browsers', 'chrome', '*', 'chrome-win64', 'chrome.exe'),
)[0];
if (!chromePath) throw new Error('Chrome for Testing not found under .browsers/');

const svg = readFileSync(resolve(root, 'src', 'assets', 'icon.svg'), 'utf8').replace(
  /viewBox="[^"]*"/,
  `viewBox="${VIEWBOX}"`,
);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setContent(
    `<style>
       * { margin: 0 }
       svg { display: block; width: 100vw; height: 100vh; color: ${COLOR} }
     </style>${svg}`,
  );
  for (const size of SIZES) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.screenshot({
      path: resolve(root, 'public', 'icon', `${size}.png`),
      omitBackground: true,
    });
    console.log(`icon/${size}.png`);
  }
} finally {
  await browser.close();
}
