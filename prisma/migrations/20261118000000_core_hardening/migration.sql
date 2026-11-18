-- v1.7.0 core hardening (audit A-11, A-12, AiHold CHECK).

-- A-12: AuditEvent's append-only trigger (INV-19) is FOR EACH ROW, and row triggers do not fire on TRUNCATE, so one
-- statement could empty the log. A statement-level trigger now refuses it, except in a *_test database (test helpers
-- empty every table) or when the session opts in with SET LOCAL app.allow_truncate = 'on' (a clone's reseed script).
-- app.truncate_guard = 'strict' turns the *_test exemption off, so INV-19 can prove the refusal in the test database.
CREATE FUNCTION audit_event_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_truncate', true) = 'on'
     OR (current_database() LIKE '%\_test' AND current_setting('app.truncate_guard', true) IS DISTINCT FROM 'strict') THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'AuditEvent is append-only: TRUNCATE refused (SET LOCAL app.allow_truncate = ''on'' to override)';
END;
$$;

CREATE TRIGGER "AuditEvent_no_truncate"
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_no_truncate();

-- A-11: on the append-style tables (nullable orgId) INSERT was WITH CHECK (true), so a write under org A's
-- app.org_id could file a row under org B. A row now carries no org, or the org the transaction is scoped to.
-- Cross-org writers (cron, sign-in, invites) run as the system role, which bypasses RLS. Same text as
-- scripts/rls-policies.ts emits from v1.7.0, so a regenerated policy migration recreates this unchanged.
DROP POLICY IF EXISTS org_insert ON "AuditEvent";
CREATE POLICY org_insert ON "AuditEvent" FOR INSERT WITH CHECK ("orgId" IS NULL OR "orgId" = nullif(current_setting('app.org_id', true), '')::uuid);
DO $$ BEGIN IF to_regclass('"Outbox"') IS NOT NULL THEN
  DROP POLICY IF EXISTS org_insert ON "Outbox";
  CREATE POLICY org_insert ON "Outbox" FOR INSERT WITH CHECK ("orgId" IS NULL OR "orgId" = nullif(current_setting('app.org_id', true), '')::uuid);
END IF; END $$;

-- An AI hold reserves a positive cost; a zero or negative hold would let a call run unbudgeted (v1.6.4 made
-- budget.ts throw on one). NOT VALID: existing rows are not re-checked, new and updated rows are.
ALTER TABLE "AiHold" ADD CONSTRAINT "AiHold_costMicros_positive" CHECK ("costMicros" > 0) NOT VALID;
