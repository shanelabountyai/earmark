// Clone-owned (v1.6.0), like org-hooks.ts: the event names this app publishes with emit() (src/core/events.ts) and
// a webhook endpoint can subscribe to (addendum §7). Rename or replace them with your own resource's, as with Project.
export const EVENT_TYPES = ['project.created'] as const;

export type EventType = (typeof EVENT_TYPES)[number];
