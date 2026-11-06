import type { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/core/env';
import { db, newClient } from './index';
import { assertLocalOrAllowed } from './local-guard';

// The owner role (BYPASSRLS). Imported only by rls.ts (asSystem) and test fixtures; INV-32 holds src/ to that.
// Unset DATABASE_URL_SYSTEM (RLS off, the default) = the app client, so an upgrade changes nothing at runtime.
if (env.DATABASE_URL_SYSTEM) assertLocalOrAllowed(env.DATABASE_URL_SYSTEM, process.env);

const g = globalThis as unknown as { prismaSystem?: PrismaClient };
export const dbSystem: PrismaClient = env.DATABASE_URL_SYSTEM ? (g.prismaSystem ??= newClient(env.DATABASE_URL_SYSTEM, 2)) : db;
