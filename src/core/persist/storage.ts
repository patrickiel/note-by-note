import { storage } from '#imports';
export const grantedOriginsItem = storage.defineItem<string[]>('local:grantedOrigins', { fallback: [] });
