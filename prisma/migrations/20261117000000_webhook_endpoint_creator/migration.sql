-- Hand-written (v1.7.0, audit A-04, owner decision 2026-11-17): a webhook endpoint has a creator, and is disabled when the
-- creator's membership ends or their role loses apikeys.manage (src/modules/apikeys/keys.ts endCredentialsOf).
-- apikeys is a removable module: a clone that removed it may have dropped the table, so every statement is guarded (F-09).
--
-- Existing rows: the creator is read back from the audit log (`webhook.endpoint_created`, written since v1.6.0), and an
-- endpoint whose creator is no longer a member of its org is disabled now, with the reason the settings page shows. Both
-- read AuditEvent and Membership, whose RLS is FORCED: they see rows only when the migrating role bypasses RLS (a superuser,
-- or a role with BYPASSRLS, as `prisma migrate deploy` runs in CI and from db:setup's owner URL). Under a role that does not,
-- they match nothing, every pre-1.7.0 endpoint keeps a null creator, and nothing is disabled: the old behaviour, never worse.
DO $$ BEGIN IF to_regclass('"WebhookEndpoint"') IS NOT NULL THEN
  ALTER TABLE "WebhookEndpoint" ADD COLUMN "createdById" UUID;

  UPDATE "WebhookEndpoint" e SET "createdById" = a."actorUserId"
    FROM "AuditEvent" a
   WHERE a."action" = 'webhook.endpoint_created' AND a."targetType" = 'webhookEndpoint' AND a."targetId" = e."id"::text
     AND a."orgId" = e."orgId" AND a."actorUserId" IS NOT NULL AND e."createdById" IS NULL;

  WITH gone AS (
    UPDATE "WebhookEndpoint" e
       SET "status" = 'disabled', "disabledAt" = now(), "updatedAt" = now(),
           "disabledReason" = 'Its creator left this organization. Check the URL, then switch it back on to take it over.'
     WHERE e."createdById" IS NOT NULL AND e."status" <> 'disabled'
       AND NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."orgId" = e."orgId" AND m."userId" = e."createdById")
    RETURNING e."orgId", e."createdById"
  )
  INSERT INTO "AuditEvent" ("orgId", "actorUserId", "action", "targetType", "targetId", "data")
  SELECT "orgId", NULL, 'webhook.disabled_with_member', 'user', "createdById"::text, jsonb_build_object('count', count(*), 'by', 'migration 20261117000000')
    FROM gone GROUP BY "orgId", "createdById";
END IF; END $$;
