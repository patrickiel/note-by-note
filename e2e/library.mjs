/** Background-library integration checks in an isolated Chrome profile.
 * Run after `wxt build --mode testing`: node e2e/library.mjs */
import assert from 'node:assert/strict';
import { globSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { emptyLibrary, applyCommand } from '../src/core/persist/library.ts';
import { makeTrackIdentity } from '../src/core/model/track-identity.ts';
import { DEFAULT_PARAMS, DEFAULT_UI_PREFS } from '../src/core/model/defaults.ts';
import { encodeSnapshot, readSnapshot, SNAPSHOT_KEY, PREFIX } from '../src/features/sync/persist/records.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(root, '.output', 'chrome-mv3-testing');
const executablePath = globSync(resolve(root, '.browsers', 'chrome', '*', 'chrome-win64', 'chrome.exe'))[0];
if (!executablePath) throw new Error('Chrome for Testing not found under .browsers/');
const profile = mkdtempSync(join(tmpdir(), 'note-by-note-library-'));
const launch = () => puppeteer.launch({ executablePath, headless: !process.argv.includes('--headful'), userDataDir: profile, protocolTimeout: 30000,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--mute-audio'] });
let browser;
const panelErrors = [];
async function panel() {
  const target = await browser.waitForTarget((target) => target.type() === 'service_worker');
  const id = new URL(target.url()).host;
  const page = await browser.newPage();
  page.on('pageerror', (error) => { panelErrors.push(error.message); console.error('Panel error:', error.message); });
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
const edit = async (page, command) => rpc(page, 'libraryEdit',
  command.type === 'practice' || command.type === 'chart'
    ? { ...command, importRevision: (await read(page)).local.importRevision ?? 0 } : command);
const sync = (page, action) => rpc(page, 'librarySync', action);
const identity = (n) => makeTrackIdentity(`https://youtube.com/watch?v=integration${n}`, `Song ${n}`, 200);

try {
  browser = await launch();
  const first = await panel();
  const second = await panel();
  await sync(first, 'disable');
  await edit(first, { type: 'import', library: emptyLibrary() });
  await first.bringToFront();
  await first.waitForSelector('button[aria-label="Settings"]');
  await first.click('button[aria-label="Settings"]');
  await first.waitForSelector('button[aria-label="Light"]');
  await first.click('button[aria-label="Light"]');
  await Promise.all([first, second].map((page) => page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { polling: 50 })));
  assert.equal((await read(first)).shared.settings.theme, 'light');
  await edit(second, { type: 'settings', patch: { theme: 'dark' } });
  await first.waitForFunction(() => document.querySelector('button[aria-label="Dark"]')?.getAttribute('aria-checked') === 'true');
  await first.click('button[aria-label="Close settings"]');
  console.log('PASS settings controls and both panel themes follow the saved library');

  const collapse = 'section[aria-label="Looper"] button[aria-expanded]';
  await first.waitForSelector(collapse);
  await first.click(collapse);
  await second.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'false', { polling: 50 }, collapse);
  assert.equal((await read(first)).local.uiPrefs.collapsedSections.looper, true);
  await second.bringToFront();
  await second.click(collapse);
  await first.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true', { polling: 50 }, collapse);
  console.log('PASS preference controls update both panels through one library watch');

  await edit(first, { type: 'preset', name: 'Study EQ', gains: [1, 2, 3] });
  await Promise.all([first, second].map((page) => page.waitForSelector('select[aria-label="EQ preset"] option[value="Study EQ"]')));
  await edit(second, { type: 'preset', name: 'Study EQ', gains: null });
  await first.waitForFunction(() => !document.querySelector('select[aria-label="EQ preset"] option[value="Study EQ"]'), { polling: 50 });
  console.log('PASS preset options follow library additions and deletions');

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
  assert.equal(saved.shared.songs[identity(0).key].practice.markers[0].t, 5);
  assert.equal(saved.shared.songs[identity(0).key].practice.params.speed, 0.5);
  console.log('PASS concurrent commands patch the latest record');

  await first.evaluate(() => { window.libraryReloadSentinel = 42; });
  const remote = applyCommand(saved, { type: 'favorite', key: identity(0).key, value: true }, Date.now() + 1000);
  const { items: remoteItems } = await encodeSnapshot(remote.shared);
  await first.evaluate((items) => chrome.storage.sync.set(items), remoteItems);
  await sync(first, 'enable');
  const received = await read(first);
  assert.deepEqual(received.shared, remote.shared);
  assert.deepEqual(received.local, saved.local);
  assert.equal(await first.evaluate(() => window.libraryReloadSentinel), 42);
  console.log('PASS remote updates preserve local data and do not reload the panel');

  await sync(first, 'disable');
  const replacement = applyCommand(emptyLibrary(), { type: 'preset', name: 'Remote only', gains: [1] }, remote.shared.updatedAt + 1000);
  const { items: replacementItems } = await encodeSnapshot(replacement.shared);
  // Header arrives before the content. Neither the old data nor a partial
  // replacement may be uploaded over this newer snapshot.
  await first.evaluate(({ key, header }) => chrome.storage.sync.set({ [key]: header }),
    { key: SNAPSHOT_KEY, header: replacementItems[SNAPSHOT_KEY] });
  await sync(first, 'enable');
  assert.deepEqual((await read(first)).shared, remote.shared);
  assert.match(await first.evaluate(async () => (await chrome.storage.local.get('syncConfig')).syncConfig.lastError), /complete synced library/);
  await first.evaluate((items) => chrome.storage.sync.set(items), replacementItems);
  await sync(first, 'now');
  assert.deepEqual((await read(first)).shared, replacement.shared);
  console.log('PASS incomplete arrivals wait; the newer snapshot replaces the whole library');

  const edited = { type: 'practice', identity: identity(98), patch: {}, recent: true };
  await edit(first, edited);
  const newest = await read(first);
  await first.evaluate(async ({ items }) => {
    const { syncConfig } = await chrome.storage.local.get('syncConfig');
    await chrome.storage.local.set({ syncConfig: { ...syncConfig, lastPushAt: 0 } });
    await chrome.storage.sync.set(items);
  }, { items: remoteItems });
  await sync(first, 'now');
  assert.deepEqual(await readSnapshot(await first.evaluate(() => chrome.storage.sync.get(null))), newest.shared);
  console.log('PASS an older remote snapshot is replaced by the newer local copy');

  await sync(first, 'disable');
  await first.evaluate(() => chrome.storage.sync.clear());
  await edit(first, { type: 'practice', identity: identity(99), patch: {}, recent: true });
  const persisted = await read(first);
  // Missing UI preferences must restore defaults without losing saved work.
  // Close the panels before seeding raw storage, so their watches only see
  // normalized data from the background when they reopen.
  const worker = await (await browser.waitForTarget((target) => target.type() === 'service_worker')).worker();
  await first.close();
  await second.close();
  await worker.evaluate(async () => {
    const { library } = await chrome.storage.local.get('library');
    delete library.local.uiPrefs;
    await chrome.storage.local.set({ library });
  });
  await browser.close();
  browser = await launch();
  const reopened = await panel();
  await reopened.waitForSelector('button[aria-label="Settings"]');
  const restored = await read(reopened);
  assert.deepEqual(restored.local, { ...persisted.local, uiPrefs: DEFAULT_UI_PREFS });
  assert.deepEqual(await reopened.evaluate(async () => (await chrome.storage.local.get('library')).library), restored);
  console.log('PASS missing preferences recover on restart without losing saved work');
  assert.deepEqual((await read(reopened)).shared, persisted.shared);
  await reopened.evaluate(async () => {
    const { syncConfig } = await chrome.storage.local.get('syncConfig');
    await chrome.storage.local.set({ syncConfig: { ...syncConfig, lastPushAt: 0 } });
  });
  await sync(reopened, 'enable');
  const uploaded = await readSnapshot(await reopened.evaluate(() => chrome.storage.sync.get(null)));
  assert.deepEqual(uploaded, persisted.shared);
  console.log('PASS restart preserves saved work and uploads it without the original panels');

  // A failed/interrupted upload is repaired from the local complete snapshot.
  await reopened.evaluate(async (key) => {
    const { syncConfig } = await chrome.storage.local.get('syncConfig');
    await chrome.storage.local.set({ syncConfig: { ...syncConfig, lastPushAt: 0 } });
    await chrome.storage.sync.set({ [key]: 'interrupted' });
  }, PREFIX + 'chunk:0');
  await sync(reopened, 'now');
  assert.deepEqual(await readSnapshot(await reopened.evaluate(() => chrome.storage.sync.get(null))), persisted.shared);
  console.log('PASS an interrupted local upload is repaired');

  const large = Array.from({ length: 5000 }, (_, n) => ({ id: `m${n}`, t: n, label: crypto.randomUUID() }));
  await edit(reopened, { type: 'practice', identity: identity(100), patch: { markers: large }, recent: true });
  // Capacity is checked only when an upload is due, before any remote write.
  await reopened.evaluate(async () => {
    const { syncConfig } = await chrome.storage.local.get('syncConfig');
    await chrome.storage.local.set({ syncConfig: { ...syncConfig, lastPushAt: 0 } });
  });
  await sync(reopened, 'now');
  const config = await reopened.evaluate(async () => (await chrome.storage.local.get('syncConfig')).syncConfig);
  assert.match(config.lastError, /storage is full/);
  assert.equal((await read(reopened)).shared.songs[identity(100).key].practice.markers.length, 5000);
  assert.deepEqual(await readSnapshot(await reopened.evaluate(() => chrome.storage.sync.get(null))), persisted.shared);
  console.log('PASS sync capacity errors retain every local marker');

  await sync(reopened, 'delete');
  assert.equal(Object.keys(await reopened.evaluate(() => chrome.storage.sync.get(null))).length, 0);
  assert.equal((await read(reopened)).shared.songs[identity(100).key].practice.markers.length, 5000);
  console.log('PASS deleting the remote copy disables sync and preserves the local library');

  // A corrupt saved record must expose a working recovery UI on the next wake.
  const recoveryBackup = await read(reopened);
  const damaged = structuredClone(recoveryBackup);
  damaged.local.recent.broken = 'not a date';
  await reopened.evaluate((library) => chrome.storage.local.set({ library }), damaged);
  await browser.close();
  browser = await launch();
  const recovery = await panel();
  await recovery.setViewport({ width: 400, height: 700 });
  await recovery.waitForSelector('main[aria-label="Library recovery"]');
  assert.match(await recovery.$eval('main', (node) => node.textContent), /saved data is still on this device/);
  await recovery.screenshot({ path: resolve(root, '.output', 'pr12-recovery.png') });
  const file = join(profile, 'restore.json');
  writeFileSync(file, JSON.stringify({ format: 'note-by-note-backup', version: 2, exportedAt: Date.now(), ...recoveryBackup }));
  recovery.once('dialog', (dialog) => dialog.accept());
  await (await recovery.$('input[aria-label="Import backup"]')).uploadFile(file);
  await recovery.waitForSelector('button[aria-label="Settings"]');
  assert.deepEqual((await read(recovery)).shared.songs, recoveryBackup.shared.songs);
  assert.deepEqual(await recovery.evaluate(async () => (await chrome.storage.local.get('libraryRecovery')).libraryRecovery), damaged);
  console.log('PASS corrupt data shows recovery controls and backup import restores the panel');
  assert.deepEqual(panelErrors, [], 'panels must not report unhandled errors');
} finally {
  await browser?.close();
}
