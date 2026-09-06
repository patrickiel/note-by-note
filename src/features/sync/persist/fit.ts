import type { FavoriteEntry, HistoryEntry, TrackData } from '../../../core/model/types.ts';
import type { Backup } from '../../../core/persist/backup-format.ts';
import {
  encodeTrack,
  hasChart,
  hasContent,
  SYNC_FORMAT_VERSION,
  type SyncSnapshot,
} from './sync-snapshot.ts';

/**
 * Fits a backup into the sync budget by leaving things out in priority order.
 * Nothing here deletes anything locally — a trimmed item simply doesn't
 * travel, and the receiving side keeps whatever it already has for it (see
 * `apply.ts`).
 *
 * Tiers, highest first:
 *   T1  settings, UI prefs, EQ presets, the Favorites list, the deletion
 *       records, and the records (markers, snippets) of favorited tracks —
 *       never trimmed
 *   T2  Recent, newest first, with those tracks' records
 *   T3  records of tracks in neither list, most recently edited first
 *   T4  chord charts, in the same order as the tracks above
 * Empty records (nothing but flags) never travel at all.
 *
 * Pure: runs under `node --test` with any size function.
 */

/** How much of each trimmable tier travels. */
export interface FitPlan {
  history: number;
  extraTracks: number;
  charts: number;
}

export interface FitMeta {
  exportedAt: number;
  appVersion: string;
  /** This snapshot re-seeds a torn area — see `SyncSnapshot.repaired`. */
  repaired?: boolean;
}

export interface Encoded<P> {
  size: number;
  payload: P;
}

export type Encode<P> = (snapshot: SyncSnapshot) => Promise<Encoded<P>>;

export interface Fitted<P> extends Encoded<P> {
  snapshot: SyncSnapshot;
  trimmed: boolean;
  plan: FitPlan;
}

/** T1 alone is over budget — nothing left to trim. */
export class SnapshotTooLargeError extends Error {
  constructor() {
    super("Your library is too large for the browser's sync storage.");
    this.name = 'SnapshotTooLargeError';
  }
}

interface Tiers {
  favorites: FavoriteEntry[];
  favTracks: TrackData[];
  history: HistoryEntry[];
  /** Aligned with `history`; null where the entry has no record of its own
   * (or it already went out with the favorites). */
  histTracks: (TrackData | null)[];
  extra: TrackData[];
}

function byKeyThenRecency(a: TrackData, b: TrackData): number {
  return b.updatedAt - a.updatedAt || (a.identity.key < b.identity.key ? -1 : 1);
}

function computeTiers(backup: Backup): Tiers {
  const content = new Map<string, TrackData>();
  for (const t of backup.tracks) if (hasContent(t)) content.set(t.identity.key, t);
  const taken = new Set<string>();
  const take = (key: string): TrackData | null => {
    const t = content.get(key);
    if (!t || taken.has(key)) return null;
    taken.add(key);
    return t;
  };
  const favTracks: TrackData[] = [];
  for (const f of backup.favorites) {
    const t = take(f.identity.key);
    if (t) favTracks.push(t);
  }
  const histTracks = backup.history.map((h) => take(h.identity.key));
  const extra = [...content.values()]
    .filter((t) => !taken.has(t.identity.key))
    .sort(byKeyThenRecency);
  return { favorites: backup.favorites, favTracks, history: backup.history, histTracks, extra };
}

function orderedTracks(tiers: Tiers, plan: FitPlan): TrackData[] {
  const hist = tiers.histTracks
    .slice(0, plan.history)
    .filter((t): t is TrackData => t !== null);
  return [...tiers.favTracks, ...hist, ...tiers.extra.slice(0, plan.extraTracks)];
}

function planFor(tiers: Tiers): FitPlan {
  return {
    history: tiers.history.length,
    extraTracks: tiers.extra.length,
    charts: orderedTracks(tiers, {
      history: tiers.history.length,
      extraTracks: tiers.extra.length,
      charts: 0,
    }).filter(hasChart).length,
  };
}

function build(backup: Backup, tiers: Tiers, plan: FitPlan, meta: FitMeta): SyncSnapshot {
  const full = planFor(tiers);
  const tracks = orderedTracks(tiers, plan);
  const chartKeys = new Set(
    tracks
      .filter(hasChart)
      .slice(0, plan.charts)
      .map((t) => t.identity.key),
  );
  return {
    v: SYNC_FORMAT_VERSION,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion,
    ...(meta.repaired ? { repaired: true } : {}),
    settings: backup.settings,
    uiPrefs: backup.uiPrefs,
    history: tiers.history.slice(0, plan.history),
    favorites: tiers.favorites,
    eqPresets: backup.eqPresets,
    tracks: tracks.map((t) => encodeTrack(t, chartKeys.has(t.identity.key))),
    deleted: backup.deletions,
    trimmed:
      plan.history < full.history ||
      plan.extraTracks < full.extraTracks ||
      plan.charts < full.charts,
  };
}

/** Everything that would travel with nothing trimmed. */
export function fullPlan(backup: Backup): FitPlan {
  return planFor(computeTiers(backup));
}

/** Deterministic for equal input, so two devices holding the same data build
 * the same snapshot. */
export function buildSnapshot(backup: Backup, plan: FitPlan, meta: FitMeta): SyncSnapshot {
  return build(backup, computeTiers(backup), plan, meta);
}

/** Trim order: the field, and the floor it may be cut to before the next
 * field is touched. Recent keeps at least 20 entries as long as anything
 * else is left to give. */
const STEPS: readonly (readonly [keyof FitPlan, number])[] = [
  ['charts', 0],
  ['extraTracks', 0],
  ['history', 20],
  ['history', 0],
];

/**
 * Encodes the largest snapshot that fits `budget`. Halves one tier at a time
 * (gzip runs a dozen times at most, on ≤ 100 KB of JSON), then binary-
 * searches the last halving back up so the cut is no deeper than it has to be.
 */
export async function fitSnapshot<P>(
  backup: Backup,
  encode: Encode<P>,
  budget: number,
  meta: FitMeta,
): Promise<Fitted<P>> {
  const tiers = computeTiers(backup);
  const attempt = async (plan: FitPlan) => {
    const snapshot = build(backup, tiers, plan, meta);
    const encoded = await encode(snapshot);
    return { ...encoded, snapshot, plan, trimmed: snapshot.trimmed };
  };
  let plan = planFor(tiers);
  let result = await attempt(plan);
  if (result.size <= budget) return result;

  for (const [field, floor] of STEPS) {
    if (plan[field] <= floor) continue;
    let over = plan[field];
    while (result.size > budget && plan[field] > floor) {
      plan = { ...plan, [field]: Math.max(floor, Math.floor(plan[field] / 2)) };
      result = await attempt(plan);
    }
    if (result.size > budget) continue;
    let fits = plan[field];
    for (let i = 0; i < 4 && over - fits > 1; i++) {
      const mid = Math.floor((fits + over) / 2);
      const candidate = await attempt({ ...plan, [field]: mid });
      if (candidate.size <= budget) {
        fits = mid;
        result = candidate;
        plan = candidate.plan;
      } else {
        over = mid;
      }
    }
    return result;
  }
  throw new SnapshotTooLargeError();
}
