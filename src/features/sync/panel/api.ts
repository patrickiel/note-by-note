import { parseBackup, type Backup } from '../../../core/persist/backup';

/** The sync worker (see /server). CORS is open there, so no host_permissions
 * are needed; self-hosters change this constant and rebuild. */
export const SYNC_ENDPOINT = import.meta.env.DEV
  ? 'http://localhost:8787'
  : 'https://note-by-note-sync.oapp.workers.dev';

export class SyncHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

/** The ID is the credential, so it travels in a header rather than the path —
 * URLs end up verbatim in the Worker's request logs. */
const BACKUP_URL = `${SYNC_ENDPOINT}/v1/backup`;

function errorFor(status: number): SyncHttpError {
  if (status === 429) {
    return new SyncHttpError(status, 'Too many sync requests — try again in a minute.');
  }
  if (status === 502) return new SyncHttpError(status, 'Sync storage is temporarily unavailable.');
  return new SyncHttpError(status, `Sync server error (${status})`);
}

/** The stored snapshot, or null if the ID has no data yet (404). */
export async function pullSnapshot(id: string): Promise<Backup | null> {
  const res = await fetch(BACKUP_URL, { headers: { 'X-Sync-Id': id } });
  if (res.status === 404) return null;
  if (!res.ok) throw errorFor(res.status);
  return parseBackup(await res.text());
}

export async function pushSnapshot(id: string, backup: Backup): Promise<void> {
  const res = await fetch(BACKUP_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Id': id },
    body: JSON.stringify(backup),
  });
  if (!res.ok) throw errorFor(res.status);
}

/** Removes the snapshot from the server. A 404 counts as success — the goal is
 * "no data under this ID", and it is already true. */
export async function deleteSnapshot(id: string): Promise<void> {
  const res = await fetch(BACKUP_URL, { method: 'DELETE', headers: { 'X-Sync-Id': id } });
  if (!res.ok && res.status !== 404) throw errorFor(res.status);
}
