// public: the landing page
// Earmark override of the template's landing (PRD-B B1, Shane's decision 3 (c), D-75): the template's page says
// "SaaS Foundation". Listed in FOUNDATION_PATCHES.md; proposed upstream as a clone hook for the app's name and landing
// (docs/upstream/saas-foundation-clone-hooks.md). Same links as the template's: sign in, demo accounts, legal.
import Link from 'next/link';
import { demoEnabled } from '@/core/auth/demo';

export const dynamic = 'force-dynamic'; // reads DEMO_MODE per request, never baked in at build

export default function Home() {
  const demo = demoEnabled();
  return (
    <main className="stack" style={{ maxWidth: '44rem' }}>
      <p className="eyebrow"><span aria-hidden="true" className="logo" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />Earmark</p>
      <h1>Marketing budgets and agency spend, one approval at a time</h1>
      <p className="lede" style={{ color: 'var(--muted)', fontSize: 18, margin: 0 }}>
        Each client company plans its budget by month, routes every spend request through an approval chain it controls, and matches agency invoices to the purchase orders those approvals issued. Agency staff see only their own agency&rsquo;s orders.{demo && ' Everything here is invented demo data.'}
      </p>
      <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: 0 }}>
        {demo && <Link className="btn" href="/demo">Try the demo</Link>}
        <Link className={demo ? 'btn btn-secondary' : 'btn'} href="/login">Sign in</Link>
      </p>
      <footer className="note">
        <Link href="/legal/privacy">Privacy</Link> · <Link href="/legal/terms">Terms</Link>
      </footer>
    </main>
  );
}
