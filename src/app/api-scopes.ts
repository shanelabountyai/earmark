// Clone-owned (v1.6.0), like org-hooks.ts: the scopes an API key can carry (addendum §7), each with its per-key rate
// limit per minute. The apikeys module ships `read` (every GET under /api/v1) and `write` (every other method); a
// clone adds its own, e.g. `ingest: { perMinute: 600 }` for a high-volume write endpoint. Order is the settings page's.
export const API_SCOPES = {
  read: { perMinute: 120, label: 'Read' },
  write: { perMinute: 20, label: 'Write' },
} as const satisfies Record<string, { perMinute: number; label: string }>;

export type ApiScope = keyof typeof API_SCOPES;
