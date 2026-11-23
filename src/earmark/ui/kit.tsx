// Earmark's page parts (D-44): server components over the classes in src/app/globals.css. Presentation only; every
// number they show is computed by the caller from real rows. Statuses are word, then glyph, then colour (HANDOFF.md).
import { now } from '@/core/clock';
import { formatUsd } from '@/lib/earmark/money';

export type Tone = 'good' | 'hold' | 'info' | 'bad' | 'done';
const GLYPH: Record<Tone, string> = { good: '✓', hold: '◆', info: '●', bad: '✕', done: '■' };

/** A status: the word carries the meaning, the glyph repeats it without colour, the colour last. */
export function Pill({ tone, glyph, big, children }: { tone: Tone; glyph?: string; big?: boolean; children: React.ReactNode }) {
  return (
    <span className={`pill pill-${tone}${big ? ' big' : ''}`}>
      <span aria-hidden="true">{glyph ?? GLYPH[tone]}</span>
      {children}
    </span>
  );
}

export function PageHead({ eyebrow, title, lede, aside }: { eyebrow?: React.ReactNode; title: React.ReactNode; lede?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {aside}
    </header>
  );
}

export function Card({ id, title, aside, className, children }: { id: string; title: React.ReactNode; aside?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className={`card${className ? ` ${className}` : ''}`}>
      {aside ? <div className="card-head"><h2 id={id}>{title}</h2>{aside}</div> : <h2 id={id}>{title}</h2>}
      {children}
    </section>
  );
}

/** A table that scrolls sideways on a phone; the wrapper is focusable so the scroll works from the keyboard. */
export function TableWrap({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="table-wrap" role="region" aria-label={`${label} (scrolls)`} tabIndex={0}>{children}</div>;
}

export const Money = ({ cents }: { cents: bigint }) => <span className="money">{formatUsd(cents)}</span>;

export type MetricItem = { label: string; cents: bigint; sub?: React.ReactNode; earmarked?: boolean };
export function Metrics({ label, items }: { label: string; items: MetricItem[] }) {
  return (
    <dl className="metrics" aria-label={label}>
      {items.map((m) => (
        <div key={m.label} className={`metric${m.earmarked ? ' earmarked' : ''}`}>
          <dt>{m.label}</dt>
          <dd className="value">{formatUsd(m.cents)}</dd>
          {m.sub && <dd className="sub">{m.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

// ---------- statuses ----------

export function RequestState({ state, waitingOn, big }: { state: string; waitingOn?: string | null; big?: boolean }) {
  const pill = {
    submitted: <Pill tone="hold" big={big}>In review</Pill>,
    approved: <Pill tone="good" big={big}>Approved</Pill>,
    rejected: <Pill tone="bad" big={big}>Rejected</Pill>,
    withdrawn: <Pill tone="done" big={big}>Withdrawn</Pill>,
    draft: <Pill tone="info" big={big}>Draft</Pill>,
  }[state] ?? <Pill tone="info" big={big}>{state}</Pill>;
  return waitingOn ? <span className="pills">{pill}<span className="muted"> waiting on {waitingOn}</span></span> : pill;
}

export function InvoiceState({ state, big }: { state: string; big?: boolean }) {
  return {
    submitted: <Pill tone="hold" big={big}>Unmatched</Pill>,
    matched: <Pill tone="info" big={big}>Matched</Pill>,
    approved: <Pill tone="good" big={big}>Approved</Pill>,
    disputed: <Pill tone="bad" big={big}>Disputed</Pill>,
    voided: <Pill tone="done" big={big}>Voided</Pill>,
  }[state] ?? <Pill tone="info" big={big}>{state}</Pill>;
}

export function VarianceState({ status }: { status: string }) {
  return {
    over: <Pill tone="bad" glyph="▲">Over</Pill>,
    under: <Pill tone="info" glyph="▼">Under</Pill>,
    'on-plan': <Pill tone="good">On plan</Pill>,
    unplanned: <Pill tone="hold">Unplanned</Pill>,
  }[status] ?? <Pill tone="info">{status}</Pill>;
}

// `awaiting`: invoices are in but none is matched yet (D-76), so the PO is not "nothing billed".
export const MATCH_STATUS: Record<string, string> = { unmatched: 'nothing billed', awaiting: 'billed, awaiting match', partial: 'part billed', matched: 'fully billed' };

export function PoState({ closed, matchStatus }: { closed: boolean; matchStatus?: string }) {
  return (
    <span className="pills">
      {closed ? <Pill tone="done">Closed</Pill> : <Pill tone="good">Open</Pill>}
      {matchStatus && <span className="muted"> · {MATCH_STATUS[matchStatus] ?? matchStatus}</span>}
    </span>
  );
}

export const day = (d: Date) => d.toISOString().slice(0, 10);

/** PRD-B B3 (review U6, D-78): a row made today (UTC) says so, so a visitor finds their own among earlier visitors'. */
export function Today({ at }: { at: Date }) {
  return day(at) === day(now()) ? <>{' '}<Pill tone="info">Today</Pill></> : null;
}
