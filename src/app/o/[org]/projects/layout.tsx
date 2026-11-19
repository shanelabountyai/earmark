import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';

// PRD §1: an agency guest sees her agency's POs and nothing else (D-51). The template's pages under here check core
// permissions, which a guest holds none of, but some (members, projects) only need membership; this refuses a guest
// the whole subtree with the same 404 as a missing page.
export default async function GuestRefused({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();
  return children;
}
