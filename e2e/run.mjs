/**
 * E2E harness: launches real Chrome with the testing build loaded, plays a
 * 440 Hz tone on a local page, drives the side panel (opened as a pinned tab),
 * and asserts on the content script's __noteByNoteDebug diagnostics — including
 * measuring the *processed output* pitch after transposing.
 *
 * Usage: node e2e/run.mjs [--headful]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, '..');
const extPath = resolve(root, '.output', 'chrome-mv3-testing');
const headful = process.argv.includes('--headful');

// Branded Chrome ≥137 ignores --load-extension; use Chrome for Testing
// (install: pnpm dlx @puppeteer/browsers install chrome@stable --path ./.browsers)
import { globSync } from 'node:fs';
const candidates = globSync(
  resolve(root, '.browsers', 'chrome', '*', 'chrome-win64', 'chrome.exe'),
);
const chromePath = candidates[0];
if (!chromePath) throw new Error('Chrome for Testing not found under .browsers/');

// ── Static server for the tone page ─────────────────────────────
const PORT = 41834;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/test-page.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(join(dir, 'fixtures', 'test-page.html')));
  } else if (url.pathname === '/csp-page.html') {
    // Strict CSP page: the worklet must still load from the extension URL.
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; media-src 'self'",
    });
    res.end(readFileSync(join(dir, 'fixtures', 'test-page.html')));
  } else if (url.pathname === '/stereo-page.html') {
    // Same fixture page but playing the stereo mix (vocal-reducer test).
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      readFileSync(join(dir, 'fixtures', 'test-page.html'), 'utf8').replace(
        '/tone-440.wav',
        '/stereo-mix.wav',
      ),
    );
  } else if (url.pathname === '/tone-440.wav' || url.pathname === '/stereo-mix.wav') {
    const wav = readFileSync(join(dir, 'fixtures', url.pathname.slice(1)));
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : wav.length - 1;
      res.writeHead(206, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${wav.length}`,
        'content-length': end - start + 1,
      });
      res.end(wav.subarray(start, end + 1));
    } else {
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': wav.length,
      });
      res.end(wav);
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((ok) => server.listen(PORT, ok));

// ── Launch Chrome with the extension ────────────────────────────
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false, // extensions need a headful (or --headless=new) browser
  userDataDir: mkdtempSync(join(tmpdir(), 'note-by-note-e2e-')),
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    ...(headful ? [] : ['--window-position=-32000,-32000']),
  ],
});

// One marker chip/row (blocks or list view). Deliberately narrower than
// "every tile": the list also renders the virtual Start boundary ("Play and
// loop section from Start"), which is not a real marker and never persisted.
const MARKER_CHIP = 'button[aria-label*="play and loop this section"]';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  // Find the extension service worker → extension id.
  let swTarget;
  try {
    swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    );
  } catch (e) {
    console.log(
      'targets:',
      browser.targets().map((t) => `${t.type()} ${t.url()}`),
    );
    throw e;
  }
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();

  // Open the media page.
  const mediaPage = await browser.newPage();
  await mediaPage.goto(`http://localhost:${PORT}/test-page.html`);

  // Resolve its tabId via the background SW.
  const tabId = await sw.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
    return tabs[0]?.id ?? null;
  }, PORT);
  check('media tab resolved', tabId != null, `tabId=${tabId}`);

  // Open the side panel UI as a pinned tab.
  const panelPage = await browser.newPage();
  panelPage.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('note-by-note')) {
      console.log(`panel console [${msg.type()}]`, msg.text());
    }
  });
  panelPage.on('pageerror', (err) => console.log('panel pageerror', String(err)));
  await panelPage.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
  await panelPage.bringToFront();

  // The testing build has host permissions → it should inject + connect.
  await new Promise((r) => setTimeout(r, 2500));

  // Debug probe runs in the content script's isolated world.
  const cdp = await mediaPage.createCDPSession();
  await cdp.send('Runtime.enable');
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.disable');
  await cdp.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 500));

  const isolated = contexts.find(
    (c) => c.auxData?.type === 'isolated' && c.origin?.includes(extId),
  );
  check('content script world found', !!isolated, isolated?.name ?? 'none');

  const probe = async (expr) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: expr,
      contextId: isolated.id,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
    return result.value;
  };

  check('content script booted', await probe('!!window.__noteByNote'));

  // Wait for the DSP chain to attach.
  let state = '';
  for (let i = 0; i < 20; i++) {
    state = (await probe('window.__noteByNoteDebug?.state?.() ?? "none"')) ?? 'none';
    if (state === 'connected-direct') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('state connected-direct', state === 'connected-direct', state);

  const rms0 = await probe('window.__noteByNoteDebug.outputRms()');
  check('output has signal', rms0 > 0.01, `rms=${rms0?.toFixed(4)}`);

  const basePitch = await probe('window.__noteByNoteDebug.outputPitch()');
  check(
    'baseline pitch ≈ 440 Hz',
    Math.abs(basePitch - 440) < 15,
    `${basePitch?.toFixed(1)} Hz`,
  );

  // ── Transpose +12 via the side panel UI (stepper hold not needed: click 12×) ──
  await panelPage.bringToFront();
  const plus = await panelPage.$('section[aria-label="Transpose"] button[aria-label="Increase Transpose"]');
  check('transpose stepper found', !!plus);
  for (let i = 0; i < 12; i++) {
    await plus.click();
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 2000));

  const params = await probe('window.__noteByNoteDebug.params()');
  check('engine received transpose=12', params?.transpose === 12, `transpose=${params?.transpose}`);

  const shifted = await probe('window.__noteByNoteDebug.outputPitch()');
  check(
    'output pitch ≈ 880 Hz after +12 st',
    Math.abs(shifted - 880) < 30,
    `${shifted?.toFixed(1)} Hz`,
  );

  // ── Speed change keeps pitch (native preservesPitch) ──
  await probe('void 0'); // keepalive
  const speedSlider = await panelPage.$('section[aria-label="Speed"] input[type="range"]');
  if (speedSlider) {
    await panelPage.evaluate((el) => {
      el.value = '75';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, speedSlider);
    await new Promise((r) => setTimeout(r, 1500));
    const rate = await probe(
      'document.getElementById("player").playbackRate',
    );
    check('playbackRate 0.75 applied', Math.abs(rate - 0.75) < 0.01, `rate=${rate}`);
    const stillShifted = await probe('window.__noteByNoteDebug.outputPitch()');
    check(
      'pitch unchanged at 75% speed',
      Math.abs(stillShifted - 880) < 35,
      `${stillShifted?.toFixed(1)} Hz`,
    );

    // ── Double-click the thumb restores the default (100%) ──
    // Click the thumb itself, not the element centre, so the press lands where
    // the value already is and only the dblclick reset moves it.
    const box = await speedSlider.boundingBox();
    const thumbX = await panelPage.evaluate((el) => {
      const THUMB = 14;
      const fraction = (Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min));
      return THUMB / 2 + fraction * (el.clientWidth - THUMB);
    }, speedSlider);
    await panelPage.mouse.click(box.x + thumbX, box.y + box.height / 2, { count: 2 });
    await new Promise((r) => setTimeout(r, 1500));
    const resetValue = await panelPage.evaluate((el) => Number(el.value), speedSlider);
    check('dblclick thumb resets slider to default', resetValue === 100, `value=${resetValue}`);
    const resetRate = await probe('document.getElementById("player").playbackRate');
    check('dblclick reset reaches engine', Math.abs(resetRate - 1) < 0.01, `rate=${resetRate}`);
  } else {
    check('speed slider found', false);
  }

  // ── Transport: pause/play via panel ──
  const playBtn = await panelPage.$('button[aria-label="Pause"], button[aria-label="Play"]');
  if (playBtn) {
    await playBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    const paused = await probe('document.getElementById("player").paused');
    check('transport pause works', paused === true, `paused=${paused}`);
    await playBtn.click(); // resume for the loop tests
    await new Promise((r) => setTimeout(r, 500));
  } else {
    check('transport button found', false);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const currentTime = () => probe('document.getElementById("player").currentTime');

  /** Holds Shift for one key press (puppeteer's `press` takes a single key). */
  const shiftPress = async (page, key) => {
    await page.keyboard.down('Shift');
    await page.keyboard.press(key);
    await page.keyboard.up('Shift');
  };

  /** Clicks the first element matching `selector` whose trimmed text is `text`.
   * Menu items and value strips are labelled by their content, not aria. */
  const clickByText = async (page, selector, text) => {
    for (const handle of await page.$$(selector)) {
      if ((await handle.evaluate((el) => el.textContent.trim())) === text) {
        await handle.click();
        return true;
      }
    }
    return false;
  };

  // ── M4: markers via keyboard shortcuts + section loop ──
  await panelPage.bringToFront();
  await panelPage.keyboard.press('Home'); // jump to start
  await sleep(1200);
  await panelPage.keyboard.press('m'); // marker ≈1.2s
  await sleep(2400);
  await panelPage.keyboard.press('m'); // marker ≈3.6s
  await sleep(300);
  const chipCount = await panelPage.$$eval(MARKER_CHIP, (els) => els.length);
  check('two marker chips shown', chipCount === 2, `count=${chipCount}`);
  const storedKeys = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all);
  });
  console.log('storage keys after marker add:', storedKeys.join(', '));
  console.log(
    'panel media:',
    JSON.stringify(
      await panelPage.evaluate(() => globalThis.__panelDebug?.media?.() ?? 'no-debug'),
    ),
    'el.duration=',
    await probe('document.getElementById("player").duration'),
    'readyState=',
    await probe('document.getElementById("player").readyState'),
  );

  // `r` (rangeSelect) loops the section the *playhead* sits in, so park it
  // between the two markers first — otherwise the playhead is still past
  // marker 2 and `r` arms 3.6 s → track end instead.
  //   Home isn't optimistic (session.t only moves once the engine echoes
  // back), so it needs a beat — but not too long a one: next-marker skips
  // anything within 0.3 s ahead, so it lands on marker 2 instead of marker 1
  // once the playhead passes 0.9 s. ~0.3 s is comfortably inside that.
  //   The seek to marker 1 *is* optimistic, and `r` then has the whole
  // 1.2–3.6 s section to land in.
  await panelPage.keyboard.press('Home');
  await sleep(300);
  await shiftPress(panelPage, 'ArrowRight'); // next marker → ≈1.2s
  await sleep(400);
  await panelPage.keyboard.press('r'); // loop marker 1 → marker 2
  await sleep(500);

  let wrapped = false;
  let maxT = 0;
  let prev = await currentTime();
  for (let i = 0; i < 14; i++) {
    await sleep(500);
    const t = await currentTime();
    maxT = Math.max(maxT, t);
    if (t < prev - 0.5) wrapped = true;
    prev = t;
  }
  check('loop wraps back to range start', wrapped, `maxT=${maxT.toFixed(2)}`);
  check('loop respects range end', maxT < 4.6, `maxT=${maxT.toFixed(2)}`);

  // ── M5: snippet from range, repeats, sequence playback ──
  await panelPage.keyboard.press('c'); // add snippet from selected range
  await sleep(400);
  const snippetCard = await panelPage.$('article[aria-label^="Snippet 1"]');
  check('snippet card created', !!snippetCard);

  // Repeats live in the snippet's parameter popovers now: "Add parameter" →
  // "Repeat" arms 2 laps, then the value strip picks the count. ∞ keeps the
  // snippet looping for the whole sampling window below.
  const addParam = await panelPage.$('article button[aria-label="Add parameter"]');
  check('snippet add-parameter button found', !!addParam);
  if (addParam) {
    await addParam.click();
    await sleep(250);
    const armed = await clickByText(
      panelPage,
      'article div[role="menu"][aria-label="Add parameter"] button[role="menuitem"]',
      'Repeat',
    );
    check('repeat override added', armed);
    await sleep(250);
    await clickByText(
      panelPage,
      'article div[role="group"][aria-label="Repeat count"] button',
      '∞',
    );
    await panelPage.keyboard.press('Escape'); // dismiss the popover
    await sleep(250);
  }
  const repeatChip = await panelPage.$('article button[aria-label^="Repeat override"]');
  check('snippet set to repeat', !!repeatChip);

  const snippetPlay = await panelPage.$('article button[aria-label="Play from this snippet"]');
  check('snippet play button found', !!snippetPlay);
  if (snippetPlay) {
    await snippetPlay.click();
    await sleep(700);
    let inBounds = true;
    let snippetWrapped = false;
    let prevT = await currentTime();
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      const t = await currentTime();
      if (t < 0.6 || t > 4.8) inBounds = false;
      if (t < prevT - 0.4) snippetWrapped = true;
      prevT = t;
    }
    check('sequence stays within snippet bounds', inBounds, `lastT=${prevT.toFixed(2)}`);
    check('snippet repeats (lap wrap observed)', snippetWrapped);
    const stopBtn = await panelPage.$('article button[aria-label="Pause sequence"]');
    if (stopBtn) await stopBtn.click();
  }

  // ── M6: markers/snippets persist across panel reload ──
  await panelPage.reload();
  await sleep(2500);
  const chipsAfter = await panelPage.$$eval(MARKER_CHIP, (els) => els.length);
  const snippetsAfter = await panelPage.$$eval(
    'article[aria-label^="Snippet"]',
    (els) => els.length,
  );
  check('markers persisted across reload', chipsAfter === 2, `count=${chipsAfter}`);
  check('snippets persisted across reload', snippetsAfter === 1, `count=${snippetsAfter}`);

  // ── Strict-CSP page: worklet must load from the extension URL ──
  const cspPage = await browser.newPage();
  await cspPage.goto(`http://localhost:${PORT}/csp-page.html`);
  const cspTabId = await sw.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({ url: `http://localhost:${port}/csp-page.html` });
    return tabs[0]?.id ?? null;
  }, PORT);
  const cspPanel = await browser.newPage();
  await cspPanel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${cspTabId}`);
  await sleep(3000);
  const cspCdp = await cspPage.createCDPSession();
  await cspCdp.send('Runtime.enable');
  const cspContexts = [];
  cspCdp.on('Runtime.executionContextCreated', (e) => cspContexts.push(e.context));
  await cspCdp.send('Runtime.disable');
  await cspCdp.send('Runtime.enable');
  await sleep(500);
  const cspWorld = cspContexts.find(
    (c) => c.auxData?.type === 'isolated' && c.origin?.includes(extId),
  );
  if (cspWorld) {
    const cspProbe = async (expr) => {
      const { result } = await cspCdp.send('Runtime.evaluate', {
        expression: expr,
        contextId: cspWorld.id,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.value;
    };
    // Strict CSP (no wasm-unsafe-eval) blocks the worklet's WASM compile —
    // the correct behavior is the §4.2 fallback: pitch-unavailable with the
    // tab-capture CTA, while transport keeps working and audio stays audible.
    let cspState = 'none';
    let cspPitchMode = 'none';
    for (let i = 0; i < 24; i++) {
      cspState = (await cspProbe('window.__noteByNoteDebug?.state?.() ?? "none"')) ?? 'none';
      cspPitchMode =
        (await cspProbe('window.__noteByNoteDebug?.pitchMode?.() ?? "none"')) ?? 'none';
      if (cspPitchMode === 'direct' || cspPitchMode === 'unavailable') break;
      await sleep(500);
    }
    check(
      'strict-CSP page degrades to pitch-unavailable',
      cspState === 'pitch-unavailable' && cspPitchMode === 'unavailable',
      `state=${cspState} pitchMode=${cspPitchMode}`,
    );
  } else {
    check('DSP attaches on strict-CSP page', false, 'no isolated world');
  }
  // ── M7: tab capture CTA from the pitch-unavailable banner ──
  // The loop above watches the *engine*, which flips the moment the worklet
  // handshake times out. The panel is a step behind: the state event has to
  // cross the port, and the banner holds its own 800 ms show-delay so
  // transient states never flash. Poll rather than sample once.
  // The banner is a highlighted card here — the whole card is the button — so
  // match on its text rather than on the inline-link variant's class.
  let captureBtn = null;
  for (let i = 0; i < 12; i++) {
    const handle = await cspPanel.evaluateHandle(() => {
      const el = document.querySelector('button.banner');
      return el && /tab capture/i.test(el.textContent ?? '') ? el : null;
    });
    captureBtn = handle.asElement();
    if (captureBtn) break;
    await handle.dispose();
    await sleep(500);
  }
  check(
    'tab-capture CTA shown on CSP page',
    !!captureBtn,
    captureBtn ? '' : `panel connection=${await cspPanel.evaluate(() => globalThis.__panelDebug?.connection?.() ?? 'no-debug')}`,
  );
  // §4.2: the effect panels the dead DSP chain owns must read as unavailable —
  // dimmed card plus a disabled slider — not silently do nothing.
  check(
    'effect panels disabled on CSP page',
    await cspPanel.evaluate(
      () =>
        document.querySelectorAll('.panel.unavailable').length >= 4 &&
        document.querySelector('input[aria-label="Pitch (cents)"]')?.disabled === true,
    ),
    `unavailable=${await cspPanel.evaluate(() => document.querySelectorAll('.panel.unavailable').length)}`,
  );
  if (captureBtn) {
    await cspPanel.bringToFront();
    await captureBtn.click();
    await sleep(2500);
    const captureResult = await cspPanel.evaluate(() => ({
      capturing: globalThis.__panelDebug?.capturing?.(),
      connection: globalThis.__panelDebug?.connection?.(),
      error: globalThis.__panelDebug?.lastError?.(),
    }));
    console.log('tab capture attempt:', JSON.stringify(captureResult));
    check(
      'tab capture starts (hybrid) or fails gracefully',
      captureResult.capturing === true || captureResult.error?.code === 'capture-failed',
      captureResult.capturing ? captureResult.connection : captureResult.error?.detail?.slice(0, 80),
    );
  }
  await cspPanel.close();
  await cspPage.close();

  // ── M8: local player page boots its own engine ──
  const localPage = await browser.newPage();
  await localPage.goto(`chrome-extension://${extId}/local-player.html`);
  const fileInput = await localPage.$('input[type="file"]');
  check('local player file input found', !!fileInput);
  if (fileInput) {
    await fileInput.uploadFile(join(dir, 'fixtures', 'tone-440.wav'));
    await sleep(3000);
    const localState = await localPage.evaluate(
      () => window.__noteByNoteDebug?.state?.() ?? 'none',
    );
    check('local player engine connected', localState === 'local-file', localState);
    const localPitch = await localPage.evaluate(
      () => window.__noteByNoteDebug?.outputPitch?.() ?? 0,
    );
    check(
      'local player pipeline audible ≈440 Hz',
      Math.abs(localPitch - 440) < 15,
      `${localPitch?.toFixed(1)} Hz`,
    );
  }
  await localPage.close();

  // ── M9: vocal reducer — center-cut kills the center vocal, keeps bass/side ──
  const vrPage = await browser.newPage();
  vrPage.on('console', (msg) => {
    if (msg.type() === 'warn' || msg.type() === 'error') {
      console.log(`stereo page console [${msg.type()}]`, msg.text());
    }
  });
  await vrPage.goto(`http://localhost:${PORT}/stereo-page.html`);
  const vrTabId = await sw.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({ url: `http://localhost:${port}/stereo-page.html` });
    return tabs[0]?.id ?? null;
  }, PORT);
  const vrPanel = await browser.newPage();
  await vrPanel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${vrTabId}`);
  await sleep(2500);
  const vrCdp = await vrPage.createCDPSession();
  await vrCdp.send('Runtime.enable');
  const vrContexts = [];
  vrCdp.on('Runtime.executionContextCreated', (e) => vrContexts.push(e.context));
  await vrCdp.send('Runtime.disable');
  await vrCdp.send('Runtime.enable');
  await sleep(500);
  const vrWorld = vrContexts.find(
    (c) => c.auxData?.type === 'isolated' && c.origin?.includes(extId),
  );
  if (vrWorld) {
    const vrProbe = async (expr) => {
      const { result } = await vrCdp.send('Runtime.evaluate', {
        expression: expr,
        contextId: vrWorld.id,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.value;
    };
    let vrState = 'none';
    for (let i = 0; i < 20; i++) {
      vrState = (await vrProbe('window.__noteByNoteDebug?.state?.() ?? "none"')) ?? 'none';
      if (vrState === 'connected-direct') break;
      await sleep(500);
    }
    if (vrState !== 'connected-direct') {
      console.log(
        'vr panel debug:',
        JSON.stringify(
          await vrPanel.evaluate(() => ({
            error: globalThis.__panelDebug?.lastError?.() ?? null,
            connection: globalThis.__panelDebug?.connection?.() ?? null,
          })),
        ),
      );
    }
    check('stereo page connected', vrState === 'connected-direct', vrState);
    await sleep(1000);
    const band = (hz) => vrProbe(`window.__noteByNoteDebug.bandDb(${hz})`);
    const base440 = await band(440);
    const base80 = await band(80);
    const base2000 = await band(2000);

    await vrPanel.bringToFront();
    const vrSlider = await vrPanel.$('section[aria-label="Vocals"] input[type="range"]');
    check('vocal reducer slider found', !!vrSlider);
    if (vrSlider) {
      // The slider is bipolar: −100 is full *reduce* (center-cut), +100 is full
      // isolate, which does the opposite and would invert every band below.
      await vrPanel.evaluate((el) => {
        el.value = '-100';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, vrSlider);
      // Bypass crossfade (~30 ms) + depth smoothing (~30 ms) + worklet latency.
      await sleep(2500);
      const cut440 = await band(440);
      const cut80 = await band(80);
      const cut2000 = await band(2000);
      check(
        'center vocal cut ≥ 10 dB',
        base440 - cut440 >= 10,
        `440 Hz ${base440?.toFixed(1)} → ${cut440?.toFixed(1)} dB`,
      );
      check(
        'bass survives (±3 dB)',
        Math.abs(base80 - cut80) <= 3,
        `80 Hz ${base80?.toFixed(1)} → ${cut80?.toFixed(1)} dB`,
      );
      check(
        'panned side survives (±3 dB)',
        Math.abs(base2000 - cut2000) <= 3,
        `2000 Hz ${base2000?.toFixed(1)} → ${cut2000?.toFixed(1)} dB`,
      );

      const vrToggle = await vrPanel.$('button[aria-label="Enable Vocals"]');
      check('vocal reducer toggle found', !!vrToggle);
      if (vrToggle) {
        await vrToggle.click();
        await sleep(2000);
        const restored440 = await band(440);
        check(
          'disable restores center vocal',
          Math.abs(restored440 - base440) <= 3,
          `440 Hz ${restored440?.toFixed(1)} vs ${base440?.toFixed(1)} dB`,
        );
      }
    }
  } else {
    check('vocal reducer world found', false, 'no isolated world');
  }
  await vrPanel.close();
  await vrPage.close();
} catch (err) {
  check('harness error', false, String(err).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
