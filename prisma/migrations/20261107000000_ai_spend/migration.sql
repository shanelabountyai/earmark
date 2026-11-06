-- CreateTable
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costMicros" BIGINT NOT NULL,
    "feature" TEXT NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiBudget" (
    "orgId" UUID NOT NULL,
    "monthlyCapMicros" BIGINT NOT NULL DEFAULT 25000000,
    "hardStop" BOOLEAN NOT NULL DEFAULT true,
    "alertAtPct" INTEGER NOT NULL DEFAULT 80,
    "pausedAt" TIMESTAMPTZ(6),
    "alertedAt" TIMESTAMPTZ(6),
    "cappedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AiBudget_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "AiHold" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "costMicros" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AiHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsage_orgId_createdAt_idx" ON "AiUsage"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AiHold_orgId_expiresAt_idx" ON "AiHold"("orgId", "expiresAt");

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiBudget" ADD CONSTRAINT "AiBudget_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiHold" ADD CONSTRAINT "AiHold_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

