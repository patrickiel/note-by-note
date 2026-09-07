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

test('the key is re-derived from the URL and title', () => {
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

test('a different title at the same URL stays its own song', () => {
  const rows = rekeyByIdentity([
    stored(URL_A, 'Song', 200, 10),
    stored(URL_A, 'Other', 200, 10),
  ]);
  assert.equal(rows.length, 2);
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
