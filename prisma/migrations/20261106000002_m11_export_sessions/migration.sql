-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "country" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(6),
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'link';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastSignInAt" TIMESTAMPTZ(6),
ADD COLUMN     "lastSignInMethod" TEXT;

-- CreateTable
CREATE TABLE "OrgExport" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "archive" BYTEA,
    "sha256" TEXT,
    "bytes" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrgExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgExport_orgId_createdAt_idx" ON "OrgExport"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrgExport" ADD CONSTRAINT "OrgExport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
