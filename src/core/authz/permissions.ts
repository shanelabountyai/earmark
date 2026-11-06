import type { Role } from '@/generated/prisma/enums';

// Pure, no I/O (spec §7b). Unknown roles get nothing.
export type Permission = 'org.update' | 'org.delete' | 'members.manage' | 'billing.manage' | 'share.create' | 'share.revoke' | 'audit.read' | 'results.write' | 'apikeys.manage';

const grants: Record<Role, readonly Permission[]> = {
  owner: ['org.update', 'org.delete', 'members.manage', 'billing.manage', 'share.create', 'share.revoke', 'audit.read', 'results.write', 'apikeys.manage'],
  admin: ['org.update', 'members.manage', 'share.create', 'share.revoke', 'audit.read', 'results.write', 'apikeys.manage'],
  member: ['share.create'],
  // D-21: enters and corrects a clone's results and nothing else; core checks results.write nowhere.
  scorekeeper: ['results.write'],
};

export const can = (role: Role, p: Permission) => grants[role]?.includes(p) ?? false;

/**
 * D-11 / INV-28: only an owner can grant, change or remove the owner role. `from` is null for an
 * invite, `to` is null for a removal. Anyone else with members.manage handles admin/member only.
 */
export const mayAssign = (actor: Role, from: Role | null, to: Role | null) =>
  can(actor, 'members.manage') && (actor === 'owner' || (from !== 'owner' && to !== 'owner'));
