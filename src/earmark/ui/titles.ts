// PRD-C C2 (review U10, A2; D-79): a page that will answer the 404 is titled "Page not found", never the page's own
// name. In this Next version a page's metadata still applies when its body calls notFound(), and the route announcer
// reads that title aloud; calling notFound() from generateMetadata with the page's own check gives the 404 page's title
// (the root not-found.tsx metadata) instead. Same check, same answer, so a foreign id still reads exactly as a missing one.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import type { Role } from '@/generated/prisma/enums';

type Params = { params: Promise<{ org: string }> };
const staff = (role: Role) => role !== 'guest';

/** generateMetadata for a page whose body answers the 404 unless `allowed(role)`: client staff by default. */
export const titleFor = (title: string, allowed: (role: Role) => boolean = staff) =>
  async ({ params }: Params): Promise<Metadata> => {
    const ctx = await requireOrg((await params).org);
    if (!allowed(ctx.role)) notFound();
    return { title };
  };

/** generateMetadata for a layout that answers the 404 unless `allowed(role)`; it sets no title of its own. */
export const guardMetadata = (allowed: (role: Role) => boolean = staff) =>
  async ({ params }: Params): Promise<Metadata> => {
    const ctx = await requireOrg((await params).org);
    if (!allowed(ctx.role)) notFound();
    return {};
  };
