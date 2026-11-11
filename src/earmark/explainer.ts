// The variance explainer (D-07): drafts one paragraph on why a line moved, under the org's AI cap (withBudget). It
// drafts; a person publishes (Phase 3). The action passes drafterFromEnv(); tests pass their own. A refused call (BudgetExceeded) writes no draft and no usage row (E-INV-08).
import { notFound } from 'next/navigation';
import { withBudget, type AiUsageReport } from '@/core/ai/budget';
import { costMicros } from '@/core/ai/prices';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { audit } from '@/core/audit';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { log } from '@/core/log';
import { formatUsd } from '@/lib/earmark/money';
import { variance } from '@/lib/earmark/variance';
import { MAX_OUTPUT, MODEL, STUB_USAGE } from '@/lib/earmark/explainer-usage';

export { MODEL };
import { requirePerm } from './core';

export const FEATURE = 'variance-explainer';

export type Drafter = {
  provider: string;
  model: string;
  maxOutputTokens: number;
  draft: (prompt: string) => Promise<{ text: string; usage: AiUsageReport }>;
};


/** Claude over plain fetch (D-31). A failed or empty call throws, so withBudget releases its hold and records nothing. */
export const claudeDrafter = (apiKey: string): Drafter => ({
  provider: 'anthropic',
  model: MODEL,
  maxOutputTokens: MAX_OUTPUT,
  async draft(prompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT, output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      log('explainer.api_error', { status: res.status, body: (await res.text()).slice(0, 300) });
      throw new Refused('The explainer could not reach the model. Try again in a minute.');
    }
    const body = (await res.json()) as { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } };
    const text = body.content.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('').trim();
    // ponytail: a refused or empty reply was billed but goes unrecorded (cents of Haiku); record it if that ever matters.
    if (!text) throw new Refused('The model returned no draft. Write the note by hand.');
    return { text, usage: { provider: 'anthropic', model: MODEL, inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } };
  },
});

// No key: a canned draft at STUB_USAGE (src/lib/earmark/explainer-usage.ts).
export const stubDrafter: Drafter = {
  provider: 'anthropic',
  model: MODEL,
  maxOutputTokens: MAX_OUTPUT,
  draft: async (prompt) => ({
    text: `Draft (no model configured): ${prompt.split('\n')[1] ?? ''} Edit this before publishing.`,
    usage: { ...STUB_USAGE },
  }),
};

export const drafterFromEnv = (): Drafter => (env.ANTHROPIC_API_KEY ? claudeDrafter(env.ANTHROPIC_API_KEY) : stubDrafter);

// ponytail: chars/3 over-counts tokens for English, so the estimate stays an upper bound (withBudget needs one);
// use the provider's token counter if the cap starts refusing calls that would have fit.
const worstCase = (d: Drafter, prompt: string) => costMicros(d.provider, d.model, Math.ceil(prompt.length / 3), d.maxOutputTokens);

export async function draftVarianceNote(ctx: OrgCtx, budgetLineId: string, drafter: Drafter) {
  requirePerm(ctx, 'variance.draft');
  const facts = await withOrg(ctx, async (tx) => {
    const line = (await tx.budgetLine.findFirst({ where: { id: budgetLineId, ...inOrg(ctx) } })) ?? notFound();
    const requests = await tx.spendRequest.findMany({ where: { ...inOrg(ctx), budgetLineId: line.id, state: 'approved' }, select: { description: true, amountCents: true }, orderBy: { submittedAt: 'asc' } });
    const matches = await tx.invoiceMatch.findMany({ where: { ...inOrg(ctx), commitment: { request: { budgetLineId: line.id } }, invoice: { state: 'approved' } }, select: { amountCents: true } });
    const actualCents = matches.reduce((a, m) => a + m.amountCents, 0n);
    const row = variance({ periodId: line.periodId, lines: [{ lineId: line.id, plannedCents: line.plannedCents, actualCents }] }).rows[0]!;
    return { line, requests, row };
  });
  const { line, requests, row } = facts;
  const prompt = [
    `Write one plain paragraph explaining the variance on the marketing budget line "${line.name}".`,
    `Planned ${formatUsd(row.plannedCents)}, actual ${formatUsd(row.actualCents)}, variance ${formatUsd(row.varianceCents)} (${row.status}).`,
    'Approved requests on the line:',
    ...requests.map((r) => `- ${formatUsd(r.amountCents)}: ${r.description}`),
  ].join('\n');
  const { text } = await withBudget(ctx, FEATURE, worstCase(drafter, prompt), () => drafter.draft(prompt));
  return withOrg(ctx, async (tx) => {
    const note = await tx.varianceNote.create({ data: { ...inOrg(ctx), budgetLineId: line.id, periodId: line.periodId, draft: text, createdById: ctx.userId } });
    await audit(ctx, 'variance.drafted', { targetType: 'varianceNote', targetId: note.id }, tx);
    return note;
  });
}
