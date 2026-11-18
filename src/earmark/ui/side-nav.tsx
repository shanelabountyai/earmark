'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useId, useState } from 'react';

export type NavLink = { href: string; label: string; exact?: boolean };

/**
 * The deep-green sidebar (HANDOFF.md, D-44): the brand, the org, the main items, the Settings group and the signed-in
 * user. One <nav> landmark per page. The current page is aria-current; on a phone the links fold behind a Menu button
 * (a <noscript> style keeps them shown when JavaScript is off). A guest with more than one client gets the
 * client switcher (owner call): switching is a plain navigation to that client's URL, which checks membership itself.
 */
export function SideNav({ home, org, main, settings, foot, clients, current }: {
  home: string; org: string; main: NavLink[]; settings: NavLink[];
  foot: { who: string[]; links: NavLink[] }; clients?: { slug: string; name: string }[]; current?: string;
}) {
  const path = usePathname();
  const router = useRouter();
  // The menu is open only for the page it was opened on, so following a link on a phone closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const collapsed = openOn !== path;
  const [pick, setPick] = useState(current ?? '');
  const bodyId = useId();
  // The deepest matching link is current: /settings/rules lights Rules, not Dashboard.
  const all = [...main, ...settings];
  const best = all.filter((l) => (l.exact ? path === l.href : path === l.href || path.startsWith(`${l.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
  const item = (l: NavLink) => <li key={l.href}><Link href={l.href} aria-current={l === best ? 'page' : undefined}>{l.label}</Link></li>;

  return (
    <nav aria-label="Earmark" className="side" data-collapsed={collapsed ? 'true' : 'false'}>
      <noscript><style>{'.side .side-body { display: flex !important } .side .menu-toggle { display: none !important }'}</style></noscript>
      <div className="side-top">
        <Link href={home} className="brand"><span aria-hidden="true" className="logo" />Earmark</Link>
        <button type="button" className="menu-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setOpenOn(collapsed ? path : null)}>
          {collapsed ? 'Menu' : 'Close menu'}
        </button>
      </div>
      <div className="side-body" id={bodyId}>
        {clients && clients.length > 1 ? (
          <form className="switch" onSubmit={(e) => { e.preventDefault(); if (pick && pick !== current) router.push(`/o/${pick}`); }}>
            <label htmlFor={`${bodyId}-client`}>Client</label>
            <div className="switch-row">
              <select id={`${bodyId}-client`} value={pick} onChange={(e) => setPick(e.target.value)}>
                {clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
              <button type="submit">Switch</button>
            </div>
          </form>
        ) : <span className="org">{org}</span>}
        <ul>{main.map(item)}</ul>
        {settings.length > 0 && <>
          <span className="group" id={`${bodyId}-settings`}>Settings</span>
          <ul className="sub" aria-labelledby={`${bodyId}-settings`}>{settings.map(item)}</ul>
        </>}
        <div className="who">
          {foot.who.map((w) => <span key={w}>{w}</span>)}
          <br />
          {foot.links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
        </div>
      </div>
    </nav>
  );
}
