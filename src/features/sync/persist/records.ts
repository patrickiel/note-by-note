import { canonical, defineEntry, emptyLibrary, type SharedLibrary } from '../../../core/persist/library.ts';
import { parseShared } from '../../../core/persist/backup-codec.ts';

export const PREFIX = 'nbn4:';
/** `browser.storage.sync` caps the whole area, one item, and the item count. */
export const QUOTA_BYTES = 102400;
const ITEM_BYTES = 8192;
const ITEM_COUNT = 512;
const encoder = new TextEncoder();
export const bytesUsed = (items: Record<string, unknown>) => Object.entries(items)
  .reduce((total, [key, value]) => total + encoder.encode(key + JSON.stringify(value)).length, 0);

async function compress(text: string): Promise<string> {
  const buffer = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function decompress(data: string): Promise<string> {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
function records(shared: SharedLibrary): Record<string, unknown> {
  return Object.fromEntries([
    [PREFIX + 'settings', shared.settings], [PREFIX + 'order', shared.favoriteOrder],
    ...Object.entries(shared.songs).map(([key, value]) => [PREFIX + 'song:' + key, value]),
    ...Object.entries(shared.presets).map(([key, value]) => [PREFIX + 'preset:' + key, value]),
  ]);
}
/** Record kinds this build owns. Anything else is read past and left in place —
 * it may belong to a newer build, and removing it would destroy that data. */
const OWNED = /^(settings|order|song:|preset:)/;

/** Each record is validated on its own, so one damaged record costs only itself.
 * Validating the whole set at once would let a single bad song block every other
 * song *and* this device's uploads, with "Delete synced data" the only way out.
 * A record written by a newer build is the one hard failure: this build cannot
 * read it, and uploading its own view over it would lose data. */
export async function readRecords(items: Record<string, unknown>): Promise<SharedLibrary> {
  const shared = emptyLibrary().shared;
  const blank = emptyLibrary().shared;
  // The casts assert nothing: `parseShared` validates the value at runtime and
  // throws for this record alone if it does not hold up.
  const validate = (patch: Partial<SharedLibrary>) => parseShared({ ...blank, ...patch });
  const map = (key: string, value: unknown) => {
    const one: Record<string, unknown> = {};
    defineEntry(one, key, value);
    return one;
  };
  for (const key of Object.keys(items).filter((key) => key.startsWith(PREFIX))) {
    const item = items[key] as { version?: unknown; data?: unknown };
    if (typeof item?.version === 'number' && item.version > 4) {
      throw new Error('Unsupported synced data. Update Note by Note on all devices.');
    }
    const name = key.slice(PREFIX.length);
    try {
      if (item?.version !== 4 || typeof item.data !== 'string') throw new Error('Damaged record.');
      const value: unknown = JSON.parse(await decompress(item.data));
      // Any other name falls through untouched: `OWNED` keeps it off the removal
      // list too, so a record this build has never heard of is left alone.
      if (name === 'settings') shared.settings = validate({ settings: value as SharedLibrary['settings'] }).settings;
      else if (name === 'order') shared.favoriteOrder = validate({ favoriteOrder: value as SharedLibrary['favoriteOrder'] }).favoriteOrder;
      else if (name.startsWith('song:')) {
        const id = name.slice(5);
        defineEntry(shared.songs, id, validate({ songs: map(id, value) as SharedLibrary['songs'] }).songs[id]);
      } else if (name.startsWith('preset:')) {
        const id = name.slice(7);
        defineEntry(shared.presets, id, validate({ presets: map(id, value) as SharedLibrary['presets'] }).presets[id]);
      }
    } catch (error) {
      console.warn('[note-by-note] a synced record could not be read and was skipped', key, error);
    }
  }
  return shared;
}
/** One record that cannot fit is reported and left behind, never truncated. */
export interface RecordChanges { changes: Record<string, unknown>; removals: string[]; skipped: string[]; usedBytes: number }
export const skippedMessage = (skipped: string[]) => `${skipped.length} saved ${skipped.length === 1
  ? 'record is' : 'records are'} too large to sync. Everything else synced; all data is kept on this device.`;

/** Write complete independent records. There is no chunk assembly or truncation. */
export async function changedRecords(local: SharedLibrary, remote: SharedLibrary, existing: Record<string, unknown>): Promise<RecordChanges> {
  const previous = records(remote);
  const next = records(local);
  const changes: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (existing[key] !== undefined && canonical(value) === canonical(previous[key])) continue;
    const item = { version: 4, data: await compress(canonical(value)) };
    // One outsized song must not hold back every other record for good.
    if (encoder.encode(key + JSON.stringify(item)).length > ITEM_BYTES) { skipped.push(key); continue; }
    changes[key] = item;
  }
  // A record the library no longer holds is dropped remotely. Without this a
  // pruned song is merged straight back on the next read, and the item count
  // climbs until the cap is hit and nothing can be written at all.
  const removals = Object.keys(existing).filter((key) => key.startsWith(PREFIX)
    && OWNED.test(key.slice(PREFIX.length)) && !(key in next));
  const build = () => {
    const proposed: Record<string, unknown> = { ...existing, ...changes };
    for (const key of removals) delete proposed[key];
    return proposed;
  };
  const overBudget = (proposed: Record<string, unknown>) =>
    bytesUsed(proposed) > QUOTA_BYTES || Object.keys(proposed).length > ITEM_COUNT;
  // Over budget, songs are held back largest-first instead of the whole batch
  // failing: settings, order and presets are small and must always get through,
  // and a song left behind stays on this device and is retried next reconcile.
  const droppable = Object.keys(changes).filter((key) => key.slice(PREFIX.length).startsWith('song:'))
    .sort((a, b) => encoder.encode(JSON.stringify(changes[b])).length - encoder.encode(JSON.stringify(changes[a])).length);
  let proposed = build();
  for (const key of droppable) {
    if (!overBudget(proposed)) break;
    delete changes[key];
    skipped.push(key);
    proposed = build();
  }
  if (overBudget(proposed)) {
    throw new Error('Browser sync storage is full. All data is kept on this device; export a backup to transfer it.');
  }
  return { changes, removals, skipped, usedBytes: bytesUsed(proposed) };
}
