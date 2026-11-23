// D-87: the nightly demo reset (D-73) runs inside /api/cron, after the template's jobs. The route's time limit is set in
// vercel.json (the route itself is template-owned) and must leave room above the reset's transaction timeout, so a slow
// night times the transaction out and rolls it back instead of Vercel killing the function mid-write.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RESET_TIMEOUT_MS } from '@/earmark/demo-reset';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { functions?: Record<string, { maxDuration?: number }> };

it('gives /api/cron an explicit maxDuration above the demo reset transaction timeout', () => {
  const max = vercel.functions?.['src/app/api/cron/route.ts']?.maxDuration;
  expect(max).toBeDefined();
  expect(max!).toBeLessThanOrEqual(300); // the Pro plan's ceiling without fluid compute (the team is on Pro, D-65)
  expect(max! * 1000).toBeGreaterThanOrEqual(RESET_TIMEOUT_MS + 30_000);
});
