// PRD-B B6 (review G6, D-77): the request audit's Details column in words, not raw JSON. Known keys read as a person
// would say them (amounts in dollars); any other key falls back to `key: value`, so nothing an audit row carries is hidden.
import { formatUsd } from '@/lib/earmark/money';

const cents = (v: unknown) => (typeof v === 'string' && /^-?\d+$/.test(v) ? formatUsd(BigInt(v)) : typeof v === 'number' && Number.isInteger(v) ? formatUsd(BigInt(v)) : String(v));
const plain = (v: unknown): string => (Array.isArray(v) ? v.map(plain).join(', ') : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

const KNOWN: Record<string, (v: unknown) => string | null> = {
  kind: (v) => (v === 'reallocation' ? 'reallocation' : `kind: ${plain(v)}`),
  amountCents: (v) => `amount ${cents(v)}`,
  steps: (v) => (Array.isArray(v) ? (v.length ? `chain ${v.map(plain).join(' → ')}` : 'no approval steps') : `steps: ${plain(v)}`),
  overBudget: (v) => (v === true ? 'over budget' : v === false ? null : `overBudget: ${plain(v)}`),
  step: (v) => (typeof v === 'number' ? `step ${v + 1}` : `step: ${plain(v)}`),
  seat: (v) => `seat ${plain(v)}`,
  toLineId: () => 'to another line',
};

/** One line of text for an audit row's `data`; an empty string when there is nothing to say. */
export function auditDetails(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object' || Array.isArray(data)) return plain(data);
  return Object.entries(data as Record<string, unknown>)
    .map(([k, v]) => (KNOWN[k] ? KNOWN[k]!(v) : `${k}: ${plain(v)}`))
    .filter((x): x is string => !!x)
    .join(' · ');
}
