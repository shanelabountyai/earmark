// D-81, D-87: the Form marks a field aria-invalid when the refusal starts with the field's label.
import { expect, it } from 'vitest';
import { labelHead, refusalNames } from '@/earmark/ui/refusal-field';

it('reads the label up to a "(USD)"-style aside', () => {
  expect(labelHead('Amount (USD)')).toBe('Amount');
  expect(labelHead('  Due date ')).toBe('Due date');
  expect(labelHead(undefined)).toBe('');
});

it('a refusal that starts with the label names that field', () => {
  expect(refusalNames('Amount must be more than zero.', 'Amount (USD)')).toBe(true);
  expect(refusalNames('Due date cannot be before the invoice date.', 'Due date')).toBe(true);
});

it('a refusal about something else names no field, and an empty label never matches', () => {
  expect(refusalNames('You cannot approve your own request.', 'Amount (USD)')).toBe(false);
  expect(refusalNames('Amount must be more than zero.', 'Invoice date')).toBe(false);
  expect(refusalNames('Amount must be more than zero.', '')).toBe(false);
  expect(refusalNames('Amount must be more than zero.', null)).toBe(false);
});
