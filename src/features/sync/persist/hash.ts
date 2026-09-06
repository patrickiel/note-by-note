import type { Backup } from '../../../core/persist/backup-format.ts';

/** JSON with object keys sorted at every level, so the same data always
 * yields the same string regardless of construction order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Content hash of a snapshot's data fields — excludes `exportedAt` and
 * `appVersion` so re-exporting unchanged data hashes the same. Tracks are
 * sorted by identity key because their storage-enumeration order is arbitrary.
 */
export async function snapshotHash(backup: Backup): Promise<string> {
  return sha256Hex(
    stableStringify({
      settings: backup.settings,
      uiPrefs: backup.uiPrefs,
      history: backup.history,
      favorites: backup.favorites,
      eqPresets: backup.eqPresets,
      tracks: [...backup.tracks].sort((a, b) =>
        a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0,
      ),
    }),
  );
}
