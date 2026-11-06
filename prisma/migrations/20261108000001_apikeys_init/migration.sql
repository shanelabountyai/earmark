-- apikeys module (addendum §7): keys, idempotent writes, webhook endpoints and deliveries.
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" UUID NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "apiKeyId" UUID NOT NULL,
    "idemKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretSealed" TEXT NOT NULL,
    "previousSecretSealed" TEXT,
    "previousSecretExpiresAt" TIMESTAMPTZ(6),
    "eventTypes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMPTZ(6),
    "disabledReason" TEXT,
    "cursorSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "lastResponseStatus" INTEGER,
    "lastResponseExcerpt" TEXT,
    "lastError" TEXT,
    "succeededAt" TIMESTAMPTZ(6),
    "replayed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

CREATE INDEX "ApiKey_orgId_idx" ON "ApiKey"("orgId");

CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

CREATE UNIQUE INDEX "IdempotencyRecord_apiKeyId_idemKey_key" ON "IdempotencyRecord"("apiKeyId", "idemKey");

CREATE INDEX "WebhookEndpoint_orgId_idx" ON "WebhookEndpoint"("orgId");

CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

CREATE INDEX "WebhookDelivery_orgId_createdAt_idx" ON "WebhookDelivery"("orgId", "createdAt");

CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OrgEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
