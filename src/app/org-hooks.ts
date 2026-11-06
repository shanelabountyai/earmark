import { revokeKeysCreatedBy } from '@/modules/apikeys/keys'; // apikeys
import type { ListedOrg } from '@/core/tenancy/listed';
import type { MembershipEnded } from '@/core/tenancy/orgs';

// Clone-owned, like cron-jobs.ts: what must happen before an org is deleted. Throwing stops the
// deletion. Removing the billing module deletes the lines marked `// billing`.
// FR-05: a deleted org must not keep charging.
export async function beforeOrgDelete(orgId: string): Promise<void> {
}

// Clone-owned (v1.4.0): which of a user's orgs the template's org lists show — `/onboarding`, where every
// sign-in lands, and each account on `/demo`. Return the ones to show; the default shows them all. A clone
// that archives orgs returns `orgs` minus the archived ones. The template keeps only ids that were in
// `orgs` (core/tenancy/listed.ts), so this can hide an org but never add or rename one. Display only:
// it does not stop a member opening `/o/<slug>`, which the clone's own pages decide.
export async function filterListedOrgs(_userId: string, orgs: readonly ListedOrg[]): Promise<readonly ListedOrg[]> {
  return orgs;
}

// Clone-owned (v1.6.0): what ends with a membership (removed, left, or account deleted), in the same transaction. The
// template revokes the API keys the person created (owner decision 2026-11-05, like K6's share links). A clone adds its
// own per-person credentials here. Throwing stops the removal.
export const onMembershipEnded: MembershipEnded = async (tx, orgId, userId) => {
  await revokeKeysCreatedBy(tx, orgId, userId); // apikeys
};
