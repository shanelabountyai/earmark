'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { setCap, setPaused } from '@/core/ai/budget';
import { orgAction } from '@/core/authz/action';

// AI spend card (addendum §6). Thin calls into src/core/ai/budget.ts (D-12), which audits each change.
const back = (slug: string) => redirect(`/o/${slug}/settings/security`);

export const setAiCap = orgAction('billing.manage', z.object({ cap: z.string() }), async (ctx, i) => {
  await setCap(ctx, i.cap);
  back(ctx.slug);
});

export const setAiPaused = orgAction('billing.manage', z.object({ on: z.enum(['1', '0']) }), async (ctx, i) => {
  await setPaused(ctx, i.on === '1');
  back(ctx.slug);
});
