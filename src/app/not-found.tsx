import Link from 'next/link';

export const metadata = { title: 'Page not found' };

// One body for every missing page (D-54): a missing id, another client's id and another agency's id all render this,
// byte for byte, so it says nothing about whether the thing exists or whose it is (E-INV-03, demo step 8).
export default function NotFound() {
  return (
    <main className="stack" style={{ maxWidth: '40rem' }}>
      <p className="eyebrow"><span aria-hidden="true" className="logo" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />Earmark</p>
      <h1>Page not found</h1>
      <p className="lede" style={{ color: 'var(--muted)', fontSize: 18 }}>There is nothing here, or nothing you can see. Check the address, or go back to your orgs.</p>
      <p><Link className="btn" href="/onboarding">Your orgs</Link></p>
    </main>
  );
}
