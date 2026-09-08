import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';
import type { ChordChart, FavoriteEntry, HistoryEntry, TrackData, TrackIdentity } from '../model/types';
import { defaults, parseLibrary } from './backup-codec.ts';
import { emptyLibrary } from './library.ts';
import { migrateBackup } from './library-migration.ts';
import { rekeyByIdentity } from './rekey.ts';

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const date = (value: unknown) => finite(value) && value >= 0 ? value : 0;

/** The automatic upgrade salvages each field independently. Backup-file imports
 * remain strict, and the original storage keys are retained for recovery. */
export function recoverLegacyStorage(raw: Record<string, unknown>) {
  const identified = (rows: unknown): (Record<string, any> & { identity: TrackIdentity; updatedAt: number })[] => list(rows).flatMap((value) => {
    const row = record(value), identity = record(row.identity);
    if (typeof identity.normalizedUrl !== 'string') return [];
    return [{ ...row, identity: makeTrackIdentity(identity.normalizedUrl,
      typeof identity.title === 'string' ? identity.title : identity.normalizedUrl,
      finite(identity.durationSec) ? identity.durationSec : 0), updatedAt: date(row.updatedAt) }];
  });
  const entry = (row: ReturnType<typeof identified>[number]): HistoryEntry => ({
    identity: row.identity, updatedAt: row.updatedAt,
    pageUrl: typeof row.pageUrl === 'string' ? row.pageUrl : row.identity.normalizedUrl,
    ...(typeof row.thumbnailUrl === 'string' ? { thumbnailUrl: row.thumbnailUrl } : {}),
    params: defaults(row.params, DEFAULT_PARAMS, true),
  });
  const chart = (value: unknown): ChordChart | null => {
    try {
      const candidate = emptyLibrary();
      candidate.local.charts.recovery = value as ChordChart;
      return parseLibrary(candidate).local.charts.recovery;
    } catch { return null; }
  };
  const tracks: TrackData[] = identified(Object.entries(raw)
    .filter(([key]) => key.startsWith('track:')).map(([, value]) => value)).map((row) => ({
    identity: row.identity, updatedAt: row.updatedAt,
    markers: list(row.markers).filter((m) => m && typeof m.id === 'string'
      && typeof m.label === 'string' && finite(m.t)),
    snippets: list(row.snippets).filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string'
      && finite(s.startT) && finite(s.endT) && (s.repeats === null || s.repeats === Infinity || finite(s.repeats))
      && typeof s.enabled === 'boolean' && s.overrides && typeof s.overrides === 'object'
      && !Array.isArray(s.overrides) && Object.values(s.overrides).every(finite)),
    sequenceLoop: row.sequenceLoop === true, sequenceCountIn: row.sequenceCountIn === true,
    ...(typeof row.chordsEnabled === 'boolean' ? { chordsEnabled: row.chordsEnabled } : {}),
    chordChart: chart(row.chordChart ?? null),
  }));
  const history = identified(raw.history).map(entry);
  const favorites: FavoriteEntry[] = identified(raw.favorites).map((row) => ({
    ...entry(row), favoritedAt: date(row.favoritedAt), lastAccessedAt: date(row.lastAccessedAt),
  }));
  const settings = defaults(raw.settings, DEFAULT_SETTINGS, true);
  const lastUsed = record(raw.settings).lastUsedParams;
  if (lastUsed) settings.lastUsedParams = defaults(lastUsed, DEFAULT_PARAMS, true);
  return parseLibrary(migrateBackup({ format: 'note-by-note-backup', version: 1,
    settings, uiPrefs: defaults(raw.uiPrefs, DEFAULT_UI_PREFS, true),
    history: rekeyByIdentity(history), favorites: rekeyByIdentity(favorites), tracks: rekeyByIdentity(tracks),
    eqPresets: list(raw.eqPresets).filter((p) => p && typeof p.name === 'string'
      && Array.isArray(p.gains) && p.gains.every(finite)),
  }));
}
