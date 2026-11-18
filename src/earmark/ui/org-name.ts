import { cache } from 'react';
import { db } from '@/core/db';

/** The org's display name for page eyebrows ("Northwind · …"), read once per request (the layout reads it too). */
export const orgName = cache(async (orgId: string) => (await db.org.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } })).name);
