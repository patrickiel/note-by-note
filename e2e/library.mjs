/** Background-library integration checks in an isolated Chrome profile.
 * Run after `wxt build --mode testing`: node e2e/library.mjs */
import assert from 'node:assert/strict';
import { globSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { emptyLibrary, applyCommand, canonical } from '../src/core/persist/library.ts';
import { makeTrackIdentity } from '../src/core/model/track-identity.ts';
import { DEFAULT_PARAMS } from '../src/core/model/defaults.ts';
import { changedRecords } from '../src/features/sync/persist/records.ts';

const extension = resolve('.output/chrome-mv3-testing');
const executablePath = globSync(resolve('.browsers/chrome/*/chrome-win64/chrome.exe'))[0];
const profile = mkdtempSync(join(tmpdir(), 'note-by-note-library-'));
const launch = () => puppeteer.launch({ executablePath, headless: true, userDataDir: profile,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--mute-audio'] });
let browser;
async function panel() {
  const target = await browser.waitForTarget((target) => target.type() === 'service_worker');
  const id = new URL(target.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html?mock=1`);
  return page;
}
async function rpc(page, type, data) {
  return page.evaluate(async ({ type, data }) => {
    const result = await chrome.runtime.sendMessage({ type, data, timestamp: Date.now(), id: 1 });
    if (result?.err) throw new Error(JSON.stringify(result.err));
    return result?.res;
  }, { type, data });
}
const read = (page) => rpc(page, 'libraryRead');
const edit = (page, command) => rpc(page, 'libraryEdit', command);
const sync = (page, action) => rpc(page, 'librarySync', action);
const identity = (n) => makeTrackIdentity(`https://youtube.com/watch?v=integration${n}`, `Song ${n}`, 200);

try {
  browser = await launch();
  const first = await panel();
  const second = await panel();
  await sync(first, 'disable');
  await edit(first, { type: 'import', library: emptyLibrary() });
  await Promise.all(Array.from({ length: 12 }, (_, n) => edit(n % 2 ? first : second, {
    type: 'practice', identity: identity(n), patch: { params: { ...DEFAULT_PARAMS, speed: 0.8 } }, recent: true,
  })));
  assert.equal(Object.keys((await read(first)).shared.songs).length, 12);
  console.log('PASS concurrent panels preserve all 12 songs');

  await Promise.all([
    edit(first, { type: 'practice', identity: identity(0), patch: { markers: [{ id: 'm', t: 5, label: 'Verse' }] }, recent: true }),
    edit(second, { type: 'practice', identity: identity(0), patch: { params: { ...DEFAULT_PARAMS, speed: 0.5 } }, recent: true }),
  ]);
  const saved = await read(first);
  assert.equal(saved.shared.songs[identity(0).key].practice.value.markers[0].t, 5);
  assert.equal(saved.shared.songs[identity(0).key].practice.value.params.speed, 0.5);
  console.log('PASS concurrent commands patch the latest record');

  await first.evaluate(() => { window.libraryReloadSentinel = 42; });
  const remote = applyCommand(saved, { type: 'favorite', key: identity(0).key, value: true }, Date.now() + 1000);
  const { changes: remoteItems } = await changedRecords(remote.shared, emptyLibrary().shared, {});
  await first.evaluate((items) => chrome.storage.sync.set(items), remoteItems);
  await sync(first, 'enable');
  const merged = await read(first);
  assert.equal(merged.shared.songs[identity(0).key].favorite.value, true);
  assert.deepEqual(merged.local, saved.local);
  assert.equal(await first.evaluate(() => window.libraryReloadSentinel), 42);
  console.log('PASS remote updates preserve local data and do not reload the panel');

  await sync(first, 'disable');
  await first.evaluate(() => chrome.storage.sync.clear());
  await edit(first, { type: 'practice', identity: identity(99), patch: {}, recent: true });
  const persisted = await read(first);
  await browser.close();
  browser = await launch();
  const reopened = await panel();
  assert.equal(canonical((await read(reopened)).shared), canonical(persisted.shared));
  await reopened.evaluate(async () => {
    const { syncConfig } = await chrome.storage.local.get('syncConfig');
    await chrome.storage.local.set({ syncConfig: { ...syncConfig, lastPushAt: 0 } });
  });
  await sync(reopened, 'enable');
  const remoteKeys = await reopened.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)));
  assert.ok(remoteKeys.includes('nbn4:song:' + identity(99).key));
  console.log('PASS restart preserves saved work and uploads it without the original panels');

  const large = Array.from({ length: 1000 }, (_, n) => ({ id: `m${n}`, t: n, label: crypto.randomUUID() }));
  await edit(reopened, { type: 'practice', identity: identity(100), patch: { markers: large }, recent: true });
  await sync(reopened, 'now');
  const config = await reopened.evaluate(async () => (await chrome.storage.local.get('syncConfig')).syncConfig);
  assert.match(config.lastError, /too large/);
  assert.equal((await read(reopened)).shared.songs[identity(100).key].practice.value.markers.length, 1000);
  console.log('PASS sync capacity errors retain every local marker');

  await sync(reopened, 'delete');
  assert.equal(Object.keys(await reopened.evaluate(() => chrome.storage.sync.get(null))).length, 0);
  assert.equal((await read(reopened)).shared.songs[identity(100).key].practice.value.markers.length, 1000);
  console.log('PASS deleting the remote copy disables sync and preserves the local library');
} finally {
  await browser?.close();
}
