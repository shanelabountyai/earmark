import { inOrg, requireOrg } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { addProject, revokeShare, shareProject } from './actions';

export const metadata = { title: 'Projects' };

// The example shareable resource. Notes are internal; a share link shows only the name.
export default async function Projects({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const [projects, links] = await withOrg(ctx, (tx) => Promise.all([
    tx.project.findMany({ where: inOrg(ctx), orderBy: { createdAt: 'asc' } }),
    tx.shareLink.findMany({ where: { ...inOrg(ctx), resourceType: 'project', revokedAt: null, expiresAt: { gt: now() } }, orderBy: { createdAt: 'asc' } }),
  ]), { atomic: false });
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);

  return (
    <main>
      <h1>Projects</h1>
      {projects.map((p) => (
        <section key={p.id}>
          <h2>{p.name}</h2>
          {p.notes && <p>{p.notes}</p>}
          {can(ctx.role, 'share.create') && (
            <ActionForm action={bind(shareProject)}>
              <input type="hidden" name="id" value={p.id} />
              <select name="days" defaultValue="7" aria-label={`Link lifetime for ${p.name}`}>
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
              </select>
              <button type="submit">Create share link</button>
            </ActionForm>
          )}
          <ul>
            {links.filter((l) => l.resourceId === p.id).map((l) => (
              <li key={l.id}>
                Link expires {l.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                {can(ctx.role, 'share.revoke') && (
                  <ActionForm action={bind(revokeShare)}>
                    <input type="hidden" name="id" value={l.id} />
                    <button type="submit">Revoke</button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <h2>New project</h2>
      <ActionForm action={bind(addProject)}>
        <label>Name <input name="name" required maxLength={120} /></label>
        <label>Internal notes <textarea name="notes" maxLength={2000} /></label>
        <button type="submit">Add project</button>
      </ActionForm>
    </main>
  );
}
