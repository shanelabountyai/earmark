import { myOrgs } from '@/earmark/ui/orgs';

/**
 * Where a /demo sign-in lands (D-58): inside the org when the account has exactly one listed org, otherwise on
 * Your orgs, as before. The list is the user's own memberships through `filterListedOrgs`, the read /onboarding makes;
 * the org page still checks membership itself.
 */
export async function demoLanding(userId: string): Promise<string> {
  const orgs = await myOrgs(userId);
  return orgs.length === 1 ? `/o/${orgs[0]!.slug}` : '/onboarding';
}
