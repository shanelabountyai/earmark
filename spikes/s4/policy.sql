-- Spike-only policy on Project, the shape rls:policies will generate. Applied as the owner after migrate deploy.
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "Project";
CREATE POLICY org_isolation ON "Project" FOR ALL
  USING ("orgId" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("orgId" = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
