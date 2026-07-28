import type { TimeDisplayFormat } from './types';

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** `mm:ss` (used for timeline endpoints and the transport bar). */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** `mm:ss.cc` with centiseconds (marker chips, snippet ranges). */
export function formatPrecise(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const cs = Math.round(seconds * 100);
  const m = Math.floor(cs / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const rest = cs % 100;
  return `${pad(m)}:${pad(sec)}.${pad(rest)}`;
}

export function formatTimeDisplay(
  seconds: number,
  duration: number,
  format: TimeDisplayFormat,
): string {
  switch (format) {
    case 'mm:ss.cc':
      return formatPrecise(seconds);
    case 'hh:mm:ss': {
      const s = Math.floor(Math.max(0, seconds));
      return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    }
    case 'seconds':
      return `${Math.max(0, seconds).toFixed(1)}s`;
    case 'remaining':
      return `−${formatClock(Math.max(0, duration - seconds))}`;
  }
}

/** Parses "mm:ss", "mm:ss.cc", "h:mm:ss", or plain seconds. Returns null when invalid. */
export function parseTime(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return null;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

export function formatTranspose(semitones: number): string {
  if (semitones > 0) return `+${semitones}`;
  return String(semitones);
}

export function formatSpeedPct(speed: number): string {
  return `${Math.round(speed * 100)}%`;
}

/** Cents ⇄ Hz conversion around a reference A4. */
export function centsToHz(cents: number, referenceHz: number): number {
  return referenceHz * Math.pow(2, cents / 1200);
}
