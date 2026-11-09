// The variance explainer (D-07): drafts one paragraph on why a line moved, under the org's AI cap (withBudget). It
// drafts; a person publishes (Phase 3). Phase 2 takes the model as an argument; Phase 4 passes the real one and adds
// the action. A refused call (BudgetExceeded) writes no draft and no usage row (E-INV-08).
import { notFound } from 'next/navigation';
import { withBudget, type AiUsageReport } from '@/core/ai/budget';
import { costMicros } from '@/core/ai/prices';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { audit } from '@/core/audit';
import { formatUsd } from '@/lib/earmark/money';
import { variance } from '@/lib/earmark/variance';
import { requirePerm } from './core';

export const FEATURE = 'variance-explainer';

export type Drafter = {
  provider: string;
  model: string;
  maxOutputTokens: number;
  draft: (prompt: string) => Promise<{ text: string; usage: AiUsageReport }>;
};

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
