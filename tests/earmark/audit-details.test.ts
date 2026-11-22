// PRD-B B6 (review G6, D-77): the request audit reads as words.
import { expect, it } from 'vitest';
import { auditDetails } from '@/earmark/audit-details';

it('reads a submitted request, a decision and unknown keys in words', () => {
  expect(auditDetails({ steps: ['Budget Owner', 'Marketing Ops'], overBudget: false, amountCents: '1200000' })).toBe('chain Budget Owner → Marketing Ops · amount $12,000.00');
  expect(auditDetails({ steps: [], overBudget: true, amountCents: '500' })).toBe('no approval steps · over budget · amount $5.00');
  expect(auditDetails({ step: 0, seat: 'Budget Owner' })).toBe('step 1 · seat Budget Owner');
  expect(auditDetails({ kind: 'reallocation', amountCents: '250000', toLineId: 'x', steps: ['Marketing Ops'] })).toBe('reallocation · amount $2,500.00 · to another line · chain Marketing Ops');
  expect(auditDetails({ reason: 'late', n: 2, nested: { a: 1 } })).toBe('reason: late · n: 2 · nested: {"a":1}');
  expect(auditDetails(null)).toBe('');
});
