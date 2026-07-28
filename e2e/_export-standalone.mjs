/**
 * Exports the side panel's main page and Settings screen as standalone HTML
 * files with all CSS embedded and image assets factored into an images/ folder.
 *
 * Strategy: serve the existing production build (.output/chrome-mv3) over HTTP,
 * open sidepanel.html?mock=1 in headless Chrome (the documented UI-preview flow:
 * a chrome shim + mock data render the panel in a plain tab), then serialize the
 * live DOM, inline every <style>/<link rel=stylesheet>, and externalize image
 * assets. The Settings screen is captured after clicking the header's Settings
 * button.
 *
 * Usage: node e2e/_export-standalone.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, globSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const buildDir = resolve(root, '.output', 'chrome-mv3');
const outDir = resolve(root, 'export');
const imagesDir = resolve(outDir, 'images');

if (!existsSync(join(buildDir, 'sidepanel.html'))) {
  throw new Error(`Build not found at ${buildDir} — run "pnpm build" first.`);
}
mkdirSync(imagesDir, { recursive: true });

// ── Chrome for Testing binary (installed for e2e) ───────────────
const chromePath = globSync(
  resolve(root, '.browsers', 'chrome', '*', 'chrome-win64', 'chrome.exe'),
)[0];
if (!chromePath) throw new Error('Chrome for Testing not found under .browsers/');

// ── Static server rooted at the build output ────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.onnx': 'application/octet-stream',
};
const PORT = 41999;
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolve(buildDir, '.' + path);
  if (!file.startsWith(buildDir) || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(PORT, ok));

// ── Captures the live DOM as a self-contained document ──────────
// Runs in the page: gathers all stylesheets (inline + linked, in DOM order so
// the cascade is preserved) and returns the head CSS + body HTML + <html> attrs.
async function capture(page) {
  return page.evaluate(async () => {
    const parts = [];
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      if (node.tagName === 'STYLE') parts.push(node.textContent ?? '');
      else parts.push(await fetch(node.href).then((r) => r.text()));
    }
    const el = document.documentElement;
    // Any raster <img> or non-data background-image on-screen (there are none on
    // these two screens, but report them so nothing is silently dropped).
    const imgs = [...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src);
    const bg = [...document.querySelectorAll('*')]
      .map((e) => getComputedStyle(e).backgroundImage)
      .filter((v) => v && v !== 'none' && !v.includes('data:') && v.includes('url('));
    return {
      css: parts.join('\n\n'),
      body: document.body.innerHTML,
      lang: el.getAttribute('lang') ?? 'en',
      theme: el.getAttribute('data-theme') ?? '',
      htmlStyle: el.getAttribute('style') ?? '',
      rasterImages: [...new Set(imgs)],
      cssBgImages: [...new Set(bg)],
    };
  });
}

// The dropdown-arrow is the one real image asset either screen uses — it lives
// as a data-URI inside the bundled CSS. Pull it out into images/ and repoint the
// CSS at the file, so "CSS embedded, images in a folder" holds literally.
function externalizeImages(css) {
  const written = [];
  // Data URIs here are double- or single-quoted; the SVG body itself contains
  // the *other* quote, so match up to the matching wrapping quote only.
  const re = /url\("(data:image\/svg\+xml,[^"]+)"\)|url\('(data:image\/svg\+xml,[^']+)'\)/g;
  const out = css.replace(re, (whole, dq, sq) => {
    const dataUri = dq ?? sq;
    const svg = decodeURIComponent(dataUri.replace('data:image/svg+xml,', ''));
    const name = 'dropdown-arrow.svg';
    if (!written.includes(name)) {
      writeFileSync(join(imagesDir, name), svg, 'utf8');
      written.push(name);
    }
    return `url("images/${name}")`;
  });
  return { css: out, written };
}

function buildDoc({ title, css, body, lang, theme, htmlStyle }) {
  const { css: extCss } = externalizeImages(css);
  // A light preview frame so the panel keeps its real ~390px width when the file
  // is opened in a full browser window instead of a docked side panel.
  const frame = `
/* ── standalone preview frame (added by export) ───────────────── */
html, body { height: 100%; }
body { margin: 0; display: flex; justify-content: center; align-items: stretch;
       background: color-mix(in srgb, var(--bg) 55%, #000); }
#app { width: 390px; max-width: 100%; height: 100dvh; overflow: hidden;
       box-shadow: 0 0 0 1px var(--border), 0 12px 48px rgba(0,0,0,.45); }
`;
  const htmlAttrs =
    ` lang="${lang}"` +
    (theme ? ` data-theme="${theme}"` : '') +
    (htmlStyle ? ` style="${htmlStyle.replace(/"/g, '&quot;')}"` : '');
  return `<!doctype html>
<html${htmlAttrs}>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
${extCss}
${frame}</style>
</head>
<body>
<div id="app">${body}</div>
</body>
</html>
`;
}

const log = (...a) => console.log(...a);
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
  // Dark is the primary theme; render "auto" against a dark preference.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  await page.goto(`http://localhost:${PORT}/sidepanel.html?mock=1`, {
    waitUntil: 'networkidle0',
  });
  await page.waitForSelector('section[aria-label="Looper"]', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400)); // settle transitions

  // ── Main page ──
  const main = await capture(page);
  log('main: raster images:', main.rasterImages, 'css bg images:', main.cssBgImages);
  writeFileSync(join(outDir, 'main.html'), buildDoc({ title: 'Note by Note — Main', ...main }), 'utf8');

  // ── Settings ──
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('section[aria-label="Settings"]', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  const settings = await capture(page);
  log('settings: raster images:', settings.rasterImages, 'css bg images:', settings.cssBgImages);
  writeFileSync(join(outDir, 'settings.html'), buildDoc({ title: 'Note by Note — Settings', ...settings }), 'utf8');

  const imgFiles = globSync(join(imagesDir, '*')).map((f) => f.replace(imagesDir + '\\', ''));
  log('\nWrote:');
  log('  export/main.html');
  log('  export/settings.html');
  log('  export/images/', imgFiles.join(', ') || '(empty)');
} finally {
  await browser.close().catch(() => {});
  server.close();
}
