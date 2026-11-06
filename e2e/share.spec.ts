import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';

// INV-08 (headers, revoke → 404) and INV-15 (share route), against the production build.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 }); // fixtures as the owner (RLS enforce)
test.afterAll(() => db.end());
test.beforeAll(() => db.query('DELETE FROM "RateLimit"')); // the server sees every local run as one IP

async function seedLink() {
  const token = randomBytes(32).toString('base64url');
  const [org, project] = [randomUUID(), randomUUID()];
  await db.query('INSERT INTO "Org" (id, slug, name, "updatedAt") VALUES ($1, $2, $2, now())', [org, `e2e-share-${org.slice(0, 8)}`]);
  await db.query('INSERT INTO "Project" (id, "orgId", name, notes) VALUES ($1, $2, $3, $4)', [project, org, 'Launch plan', 'margin is 12%']);
  const { rows } = await db.query(
    `INSERT INTO "ShareLink" (id, "orgId", "resourceType", "resourceId", "tokenHash", "expiresAt")
     VALUES ($1, $2, 'project', $3, $4, now() + interval '1 day') RETURNING id`,
    [randomUUID(), org, project, createHash('sha256').update(token).digest('hex')],
  );
  return { token, linkId: rows[0].id as string };
}

function expectShareHeaders(h: Record<string, string>) {
  expect(h['referrer-policy']).toBe('no-referrer'); // overrides the global policy on /s/*
  expect(h['x-robots-tag']).toBe('noindex, nofollow');
  expect(h['cache-control']).toContain('no-store');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['strict-transport-security']).toContain('max-age=');
}

test('a live link shows the projection only, with the share headers', async ({ page }) => {
  const { token } = await seedLink();
  const res = await page.goto(`/s/${token}`);
  expect(res!.status()).toBe(200);
  expectShareHeaders(res!.headers());
  await expect(page.getByRole('heading', { name: 'Launch plan' })).toBeVisible();
  await expect(page.getByText('margin')).toHaveCount(0);
});

test('revoke is immediate, and an unknown token gets the same 404 and headers', async ({ request }) => {
  const { token, linkId } = await seedLink();
  expect((await request.get(`/s/${token}`)).status()).toBe(200);
  await db.query('UPDATE "ShareLink" SET "revokedAt" = now() WHERE id = $1', [linkId]);
  const revoked = await request.get(`/s/${token}`);
  expect(revoked.status()).toBe(404);
  expectShareHeaders(revoked.headers());
  expect((await request.get('/s/not-a-token')).status()).toBe(404);
});
