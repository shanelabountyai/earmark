-- v1.7.0 (sso module): one verified org per domain, enforced by the database, and verification that can lapse.
-- Guarded: a clone that removed the sso module may have dropped the table (README "Removing a module", F-09).
DO $$ BEGIN IF to_regclass('"SsoDomain"') IS NOT NULL THEN
  -- domainVerifiedElsewhere() checked before writing, so two orgs verifying at once could both win. The index makes
  -- the second write fail (verifyDomain maps it to "Another org has already verified this domain").
  CREATE UNIQUE INDEX IF NOT EXISTS "SsoDomain_domain_verified_key" ON "SsoDomain"("domain") WHERE "verifiedAt" IS NOT NULL;
  -- The cron re-check: when the TXT record was last seen, and when it was first found missing.
  ALTER TABLE "SsoDomain" ADD COLUMN IF NOT EXISTS "checkedAt" TIMESTAMPTZ(6);
  ALTER TABLE "SsoDomain" ADD COLUMN IF NOT EXISTS "checkFailedAt" TIMESTAMPTZ(6);
END IF; END $$;
