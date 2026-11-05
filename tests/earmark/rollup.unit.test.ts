import { describe, expect, it } from 'vitest';
import { ageDays, type Ledger, LedgerError, rollup, rollupToJson } from '@/lib/earmark/rollup';

const base: Ledger = {
  programs: [{ id: 'p1' }],
  campaigns: [{ id: 'c1', programId: 'p1' }, { id: 'c2', programId: 'p1' }],
  lines: [
    { id: 'l1', campaignId: 'c1', periodId: '2026-11', plannedCents: 100000n },
    { id: 'l2', campaignId: 'c2', periodId: '2026-11', plannedCents: 50000n },
    { id: 'l3', campaignId: 'c1', periodId: '2026-12', plannedCents: 10n },
  ],
  commitments: [
    { id: 'po-1', lineId: 'l1', amountCents: 60000n, state: 'open' },
    { id: 'po-2', lineId: 'l1', amountCents: 20000n, state: 'closed' },
    { id: 'po-3', lineId: 'l3', amountCents: 5n, state: 'open' },
  ],
  matches: [
    { invoiceId: 'i1', commitmentId: 'po-2', amountCents: 20000n, state: 'approved' },
    { invoiceId: 'i2', commitmentId: 'po-1', amountCents: 10000n, state: 'pending' },
  ],
  invoices: [
    { id: 'i1', amountCents: 20000n, state: 'approved' },
    { id: 'i2', amountCents: 10000n, state: 'matched' },
    { id: 'i3', amountCents: 7000n, state: 'submitted', lineId: 'l1', submittedOn: '2026-10-22' },
    { id: 'i4', amountCents: 3000n, state: 'submitted', submittedOn: '2026-11-05T00:00:00Z' },
    { id: 'i5', amountCents: 1n, state: 'submitted', lineId: 'l3' },
  ],
  now: '2026-11-05T12:00:00Z',
};

describe('rollup (PRD §2 derived values, §4)', () => {
  it('derives line, campaign, program and org rows', () => {
    const r = rollup(base);
    expect(r.lines.map((l) => l.lineId)).toEqual(['l1', 'l2', 'l3']);
    expect(r.lines[0]).toMatchObject({ plannedCents: 100000n, committedCents: 60000n, actualCents: 20000n, unmatchedProvisionCents: 7000n, availableCents: 33000n, overCommitted: false, committedBps: 6000n, actualBps: 2000n, programId: 'p1', campaignId: 'c1' });
    expect(r.lines[1]).toMatchObject({ committedCents: 0n, actualCents: 0n, availableCents: 50000n, committedBps: 0n });
    expect(r.campaigns).toEqual([
      { campaignId: 'c1', programId: 'p1', lineCount: 2, plannedCents: 100010n, committedCents: 60005n, actualCents: 20000n, unmatchedProvisionCents: 7001n, availableCents: 33004n },
      { campaignId: 'c2', programId: 'p1', lineCount: 1, plannedCents: 50000n, committedCents: 0n, actualCents: 0n, unmatchedProvisionCents: 0n, availableCents: 50000n },
    ]);
    expect(r.programs).toEqual([{ programId: 'p1', lineCount: 3, plannedCents: 150010n, committedCents: 60005n, actualCents: 20000n, unmatchedProvisionCents: 7001n, availableCents: 83004n }]);
    expect(r.org).toEqual({ lineCount: 3, plannedCents: 150010n, committedCents: 60005n, actualCents: 20000n, unmatchedProvisionCents: 7001n, availableCents: 83004n });
    expect(r.unassignedUnmatchedCents).toBe(3000n);
    expect(r.orgAvailableCents).toBe(80004n);
    expect(r.unmatchedInvoices).toEqual([
      { invoiceId: 'i3', amountCents: 7000n, lineId: 'l1', ageDays: 14 },
      { invoiceId: 'i4', amountCents: 3000n, lineId: null, ageDays: 0 },
      { invoiceId: 'i5', amountCents: 1n, lineId: 'l3', ageDays: null },
    ]);
  });
  it('filters to a period, keeping org-level unassigned invoices', () => {
    const r = rollup({ ...base, periodId: '2026-12' });
    expect(r.periodId).toBe('2026-12');
    expect(r.lines.map((l) => l.lineId)).toEqual(['l3']);
    expect(r.org).toMatchObject({ lineCount: 1, plannedCents: 10n, committedCents: 5n, unmatchedProvisionCents: 1n, availableCents: 4n });
    expect(r.unmatchedInvoices.map((u) => u.invoiceId)).toEqual(['i4', 'i5']);
    expect(r.orgAvailableCents).toBe(-2996n); // 4 available − 3000 unassigned
  });
  it('shows available negative rather than clamping', () => {
    const r = rollup({ ...base, lines: [{ id: 'l1', campaignId: 'c1', periodId: 'x', plannedCents: 1n }], commitments: [{ id: 'po', lineId: 'l1', amountCents: 5n, state: 'open' }], matches: [], invoices: [] });
    expect(r.lines[0]).toMatchObject({ availableCents: -4n, overCommitted: true, committedBps: 50000n });
  });
  it('accepts cents as JSON integers and digit strings', () => {
    const r = rollup({ ...base, lines: [{ id: 'l1', campaignId: 'c1', periodId: 'x', plannedCents: '12' as unknown as bigint }], commitments: [{ id: 'po', lineId: 'l1', amountCents: 5 as unknown as bigint, state: 'open', requestAmountCents: 5 as unknown as bigint }], matches: [], invoices: [] });
    expect(r.lines[0]!.availableCents).toBe(7n);
  });
  it('refuses a broken ledger with a code', () => {
    const code = (l: Partial<Ledger>) => {
      try {
        rollup({ ...base, ...l });
      } catch (e) {
        return e instanceof LedgerError ? `${e.name}:${e.code}` : (e as { code?: string }).code;
      }
      return 'ok';
    };
    expect(code({ commitments: [{ id: 'x', lineId: 'nope', amountCents: 1n, state: 'open' }] })).toBe('LedgerError:UNKNOWN_LINE');
    expect(code({ commitments: [{ id: 'x', lineId: 'l1', amountCents: 2n, state: 'open', requestAmountCents: 1n }] })).toBe('LedgerError:COMMITMENT_EXCEEDS_REQUEST');
    expect(code({ commitments: [{ id: 'x', lineId: 'l1', amountCents: 2n, state: 'void' as 'open' }] })).toBe('LedgerError:BAD_STATE');
    expect(code({ commitments: [base.commitments[0]!, base.commitments[0]!] })).toBe('LedgerError:DUPLICATE_ID');
    expect(code({ matches: [{ invoiceId: 'i', commitmentId: 'nope', amountCents: 1n, state: 'approved' }] })).toBe('LedgerError:UNKNOWN_COMMITMENT');
    expect(code({ matches: [{ invoiceId: 'i', commitmentId: 'po-1', amountCents: 1n, state: 'done' as 'approved' }] })).toBe('LedgerError:BAD_STATE');
    expect(code({ invoices: [{ id: 'i', amountCents: 1n, state: 'submitted', lineId: 'nope' }] })).toBe('LedgerError:UNKNOWN_LINE');
    expect(code({ invoices: [{ id: 'i', amountCents: 1n, state: 'submitted', submittedOn: 'whenever' }] })).toBe('LedgerError:BAD_DATE');
    expect(code({ campaigns: [{ id: 'c1', programId: 'nope' }] })).toBe('LedgerError:UNKNOWN_PROGRAM');
    expect(code({ lines: [{ id: 'l', campaignId: 'nope', periodId: 'x', plannedCents: 1n }] })).toBe('LedgerError:UNKNOWN_CAMPAIGN');
    expect(code({ programs: [{ id: 'p1' }, { id: 'p1' }] })).toBe('LedgerError:DUPLICATE_ID');
    expect(code({ lines: [{ id: 'l1', campaignId: 'c1', periodId: 'x', plannedCents: -1n }], commitments: [], matches: [], invoices: [] })).toBe('CENTS_BELOW_MIN');
    expect(code({ invoices: [{ id: 'i', amountCents: 1.5 as unknown as bigint, state: 'voided' }] })).toBe('NOT_INTEGER_CENTS');
    expect(code({})).toBe('ok');
  });
  it('ageDays floors whole days and tolerates missing dates', () => {
    expect(ageDays('2026-10-22', '2026-11-05T12:00:00Z')).toBe(14);
    expect(ageDays('2026-11-05T13:00:00Z', '2026-11-05T12:00:00Z')).toBe(-1);
    expect(ageDays(null, '2026-11-05')).toBeNull();
    expect(ageDays('2026-11-05', undefined)).toBeNull();
    expect(() => ageDays('2026-11-05', 'now')).toThrow(LedgerError);
  });
  it('rollupToJson writes integers', () => {
    const j = rollupToJson(rollup(base)) as { org: { plannedCents: number }; lines: { committedBps: number | null }[]; unmatchedInvoices: { amountCents: number }[] };
    expect(j.org.plannedCents).toBe(150010);
    expect(j.lines[0]!.committedBps).toBe(6000);
    expect(j.unmatchedInvoices[0]!.amountCents).toBe(7000);
    expect(JSON.stringify(j)).not.toContain('n"');
  });
});
