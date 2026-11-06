import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/core/env';
import { assertLocalOrAllowed } from './local-guard';

assertLocalOrAllowed(env.DATABASE_URL, process.env);

// Reused across dev hot reloads so each reload doesn't open a new pool.
const g = globalThis as unknown as { prisma?: PrismaClient };

// timezone=UTC: the adapter sends a Date with no offset, so Postgres reads it in the session zone.
// On a laptop set to America/Chicago every write landed 5-6h off against now() and column defaults
// (found in M6: a SQL-seeded session read as expired). Cloud Postgres defaults to UTC, which hid it.
// With a separate system pool (addendum §10.1) the app keeps 8 of the project's 10 connections.
export const newClient = (connectionString: string, max?: number) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, options: '-c timezone=UTC', ...(max && { max }) }) });

/** The app role. In RLS enforce mode it cannot bypass policies: org-owned rows go through `withOrg` (src/core/db/rls.ts). */
export const db = (g.prisma ??= newClient(env.DATABASE_URL, env.DATABASE_URL_SYSTEM ? 8 : undefined));
