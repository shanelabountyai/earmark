'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import type { OrgCtx } from '@/core/authz/guards';
import { createKey, revokeKey } from '@/modules/apikeys/keys';
import { createEndpoint, deleteEndpoint, replayDelivery, rotateSecret, setEndpointStatus } from '@/modules/apikeys/webhooks';

// Thin calls into the apikeys module (D-12), which audits each change. A key or signing secret exists only in the
// response that creates it (`notice`), like a share link.
const page = (ctx: OrgCtx) => `/o/${ctx.slug}/settings/apikeys`;
const back = (ctx: OrgCtx) => redirect(page(ctx));
// A checkbox group named `scopes[]` / `eventTypes[]`: orgAction's form reader hands it over as an array.
const list = z.array(z.string()).default([]);

export const createApiKey = orgAction('apikeys.manage', z.object({ label: z.string(), scopes: list }), async (ctx, i) => {
  const key = await createKey(ctx, i);
  revalidatePath(page(ctx));
  return { notice: `Your new key, shown once: ${key}` };
});

export const revokeApiKey = orgAction('apikeys.manage', z.object({ id: ref('apiKey') }), async (ctx, { id }) => {
  await revokeKey(ctx, id);
  back(ctx);
});

export const createWebhookEndpoint = orgAction('apikeys.manage', z.object({ url: z.string(), eventTypes: list }), async (ctx, i) => {
  const secret = await createEndpoint(ctx, i);
  revalidatePath(page(ctx));
  return { notice: `Signing secret, shown once: ${secret}` };
});

export const rotateWebhookSecret = orgAction('apikeys.manage', z.object({ id: ref('webhookEndpoint') }), async (ctx, { id }) => {
  const secret = await rotateSecret(ctx, id);
  revalidatePath(page(ctx));
  return { notice: `New signing secret, shown once: ${secret}. The old one keeps signing for 24 hours.` };
});

export const setWebhookStatus = orgAction('apikeys.manage', z.object({ id: ref('webhookEndpoint'), to: z.enum(['active', 'disabled']) }), async (ctx, i) => {
  await setEndpointStatus(ctx, i.id, i.to);
  back(ctx);
});

export const deleteWebhookEndpoint = orgAction('apikeys.manage', z.object({ id: ref('webhookEndpoint') }), async (ctx, { id }) => {
  await deleteEndpoint(ctx, id);
  back(ctx);
});

export const replayWebhookDelivery = orgAction('apikeys.manage', z.object({ id: ref('webhookDelivery') }), async (ctx, { id }) => {
  await replayDelivery(ctx, id);
  back(ctx);
});
