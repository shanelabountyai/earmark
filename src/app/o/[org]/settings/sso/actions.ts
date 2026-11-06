'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { notRef, orgAction, ref } from '@/core/authz/action';
import type { OrgCtx } from '@/core/authz/guards';
import { Role } from '@/generated/prisma/enums';
import { addDomain, removeDomain, saveConnection, setEnabled, setRequired, verifyDomain } from '@/modules/sso/settings';

// Thin calls into the sso module (D-12), which checks the owner role and audits each change.
const back = (ctx: OrgCtx) => redirect(`/o/${ctx.slug}/settings/sso`);
const on = z.enum(['1', '0']).transform((v) => v === '1');

export const saveSsoConnection = orgAction(
  'org.update',
  z.object({ issuer: z.string(), clientId: notRef(z.string()), clientSecret: z.string().default(''), allowedDomains: z.string().default(''), defaultRole: z.enum(Role) }),
  async (ctx, i) => {
    await saveConnection(ctx, i);
    back(ctx);
  },
);

export const setSsoEnabled = orgAction('org.update', z.object({ on }), async (ctx, i) => {
  await setEnabled(ctx, i.on);
  back(ctx);
});

export const setSsoRequired = orgAction('org.update', z.object({ on }), async (ctx, i) => {
  await setRequired(ctx, i.on);
  redirect(`/o/${ctx.slug}/settings/security`); // the switch lives on the Security page (addendum §4)
});

export const addSsoDomain = orgAction('org.update', z.object({ domain: z.string() }), async (ctx, i) => {
  await addDomain(ctx, i.domain);
  back(ctx);
});

export const verifySsoDomain = orgAction('org.update', z.object({ id: ref('ssoDomain') }), async (ctx, { id }) => {
  await verifyDomain(ctx, id);
  back(ctx);
});

export const removeSsoDomain = orgAction('org.update', z.object({ id: ref('ssoDomain') }), async (ctx, { id }) => {
  await removeDomain(ctx, id);
  back(ctx);
});
