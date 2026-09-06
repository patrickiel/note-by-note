import { encodeBackup, type Backup } from '../../../core/persist/backup-codec.ts';

/**
 * Content identity of a backup: the compact encoding with its clock zeroed.
 * Two devices holding the same data produce the same text — the codec is
 * deterministic and idempotent — so hashes compare across devices, and a
 * re-export of unchanged data hashes the same. Pure; `node --test`.
 */
export function contentText(backup: Backup): string {
  return JSON.stringify({ ...encodeBackup(backup), at: 0 });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function contentHash(backup: Backup): Promise<string> {
  return sha256Hex(contentText(backup));
}
