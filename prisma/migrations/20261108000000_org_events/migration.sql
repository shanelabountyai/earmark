-- Core event log (addendum §7, D-28): emit() writes here; the apikeys module reads it.
ALTER TABLE "Org" ADD COLUMN     "eventSeq" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "OrgEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "seq" INTEGER,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "key" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgEvent_orgId_seq_key" ON "OrgEvent"("orgId", "seq");

CREATE UNIQUE INDEX "OrgEvent_orgId_key_key" ON "OrgEvent"("orgId", "key");

ALTER TABLE "OrgEvent" ADD CONSTRAINT "OrgEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (port of Bookable W-008, W-D18). seq is handed out by a DEFERRED constraint trigger, i.e. at COMMIT,
-- after every other lock the writing transaction takes: seq order is commit order (the Org row lock is held until the
-- commit is visible), a rolled-back transaction never fires it (gapless), and no writer has to take part. Fan-out
-- reads "everything above my cursor", which a late-committing event can never fall below.
-- SECURITY DEFINER runs it as the migration owner, so in RLS enforce mode it can number an event whatever the setting.
CREATE OR REPLACE FUNCTION "org_event_assign_seq"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE next_seq INTEGER;
BEGIN
  UPDATE "Org" SET "eventSeq" = "eventSeq" + 1 WHERE "id" = NEW."orgId" RETURNING "eventSeq" INTO next_seq;
  UPDATE "OrgEvent" SET "seq" = next_seq WHERE "id" = NEW."id";
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "org_event_seq"
  AFTER INSERT ON "OrgEvent"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "org_event_assign_seq"();
