// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rekeyByIdentity, type Keyed } from './rekey.ts';
import { makeTrackIdentity, songKey } from '../model/track-identity.ts';
import type { TrackIdentity } from '../model/types.ts';

const URL_A = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const URL_B = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';

/** A row as an older build stored it: the key it used baked in the duration. */
function stored(url: string, title: string, durationSec: number, updatedAt: number) {
  const identity: TrackIdentity = {
    ...makeTrackIdentity(url, title, durationSec),
    key: `legacy:${durationSec}`,
  };
  return { identity, updatedAt, mark: `${title}@${durationSec}` };
}

test('the key is re-derived from the media identity', () => {
  const [row] = rekeyByIdentity([stored(URL_A, 'Song', 200, 1)]);
  assert.equal(row.identity.key, songKey(row.identity));
  assert.equal(row.identity.durationSec, 200, 'duration is kept, as metadata');
});

test('copies of one song under drifted durations collapse to the newest', () => {
  const rows = rekeyByIdentity([
    stored(URL_A, 'Song', 200, 10),
    stored(URL_A, 'Song', 201, 30),
    stored(URL_A, 'Song', 199, 20),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mark, 'Song@201', 'the most recently written copy');
});

test('late web titles do not create another song', () => {
  const rows = rekeyByIdentity([
    stored(URL_A, 'Song', 200, 10),
    stored(URL_A, 'Other', 200, 10),
  ]);
  assert.equal(rows.length, 1);
});

test('local files remain distinct and do not depend on the installation URL', () => {
  const a = makeTrackIdentity('chrome-extension://aaa/local-player.html', 'one.mp3', 20);
  const b = makeTrackIdentity('moz-extension://bbb/local-player.html', 'one.mp3', 21);
  const c = makeTrackIdentity('chrome-extension://aaa/local-player.html', 'two.mp3', 20);
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test('list order is kept, at the position of the first copy seen', () => {
  const rows = rekeyByIdentity([
    stored(URL_A, 'First', 200, 10),
    stored(URL_B, 'Second', 200, 10),
    stored(URL_A, 'First', 201, 99),
  ]);
  assert.deepEqual(rows.map((r) => r.mark), ['First@201', 'Second@200']);
});

test('rows without a usable identity are dropped, never merged into one', () => {
  const junk = [
    { identity: undefined, updatedAt: 1 },
    { identity: {}, updatedAt: 2 },
    null,
  ] as unknown as Keyed[];
  assert.deepEqual(rekeyByIdentity([...junk, stored(URL_A, 'Song', 200, 1)]).length, 1);
});

test('re-running it changes nothing', () => {
  const once = rekeyByIdentity([stored(URL_A, 'Song', 200, 10), stored(URL_B, 'Two', 90, 20)]);
  assert.deepEqual(rekeyByIdentity(once), once);
});
