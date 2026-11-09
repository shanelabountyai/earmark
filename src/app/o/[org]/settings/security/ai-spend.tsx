import { budgetOf, monthSpend } from '@/core/ai/budget';
import type { OrgCtx } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { setAiCap, setAiPaused } from './actions';

const dollars = (m: bigint) => (Number(m) / 1e6).toFixed(2);

/** This month's AI spend, the cap and a pause switch (§6). Owners and admins see it; billing.manage changes it. */
export async function AiSpendCard({ ctx }: { ctx: OrgCtx }) {
  const { budget, spent } = await withOrg(ctx, async (tx) => ({ budget: await budgetOf(tx, ctx.orgId), spent: await monthSpend(tx, ctx.orgId) }));
  const manage = can(ctx.role, 'billing.manage');
  return (
    <section aria-labelledby="ai-spend">
      <h2 id="ai-spend">AI spending</h2>
      <p>
        This month: <strong>${dollars(spent)}</strong> of a <strong>${dollars(budget.monthlyCapMicros)}</strong> limit
        {budget.pausedAt ? '. AI features are paused.' : '.'}
      </p>
      {manage && (
        <>
          <ActionForm action={setAiCap.bind(null, ctx.slug)}>
            <label>
              Monthly limit (USD) <input name="cap" inputMode="decimal" defaultValue={dollars(budget.monthlyCapMicros)} required />
            </label>
            <button type="submit">Save limit</button>
          </ActionForm>
          <ActionForm action={setAiPaused.bind(null, ctx.slug)}>
            <input type="hidden" name="on" value={budget.pausedAt ? '0' : '1'} />
            <button type="submit">{budget.pausedAt ? 'Resume AI features' : 'Pause AI features'}</button>
          </ActionForm>
        </>
      )}
    </section>
  );
}
