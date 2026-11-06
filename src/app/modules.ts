// Clone-owned (v1.6.0), like org-hooks.ts: the optional modules that plug into core. Imported for its side effect by
// the routes that sign people in (/login/request, /login/redeem), and for each module's tables in a data export
// (export-hooks.ts; secrets never selected, INV-34). Removing a module deletes its marked lines (foundation:check-modules).
import type { ExportTable } from '@/core/tenancy/export';
import { registerSsoHooks } from '@/core/auth/sso-hook'; // sso
import { ssoHooks } from '@/modules/sso/hooks'; // sso

registerSsoHooks(ssoHooks); // sso

export const moduleExportTables: readonly ExportTable[] = [
  { name: 'SsoConnection', rows: (tx, orgId) => tx.ssoConnection.findMany({ where: { orgId }, select: { issuer: true, clientId: true, defaultRole: true, allowedDomains: true, required: true, enabledAt: true, createdAt: true } }) }, // sso
  { name: 'ApiKey', rows: (tx, orgId) => tx.apiKey.findMany({ where: { orgId }, select: { id: true, label: true, prefix: true, scopes: true, createdById: true, lastUsedAt: true, revokedAt: true, createdAt: true } }) }, // apikeys
  { name: 'WebhookEndpoint', rows: (tx, orgId) => tx.webhookEndpoint.findMany({ where: { orgId }, select: { id: true, url: true, eventTypes: true, status: true, disabledReason: true, cursorSeq: true, createdAt: true } }) }, // apikeys
  { name: 'SsoDomain', rows: (tx, orgId) => tx.ssoDomain.findMany({ where: { orgId }, select: { domain: true, verifiedAt: true, createdAt: true } }) }, // sso
];
