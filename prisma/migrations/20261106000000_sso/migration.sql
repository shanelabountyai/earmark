-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "mfaOrgId" UUID;

-- CreateTable
CREATE TABLE "SsoConnection" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretSealed" TEXT NOT NULL,
    "defaultRole" "Role" NOT NULL DEFAULT 'member',
    "allowedDomains" TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "requiredAt" TIMESTAMPTZ(6),
    "requiredById" UUID,
    "enabledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoDomain" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoState" (
    "hash" TEXT NOT NULL,
    "orgId" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SsoState_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "SsoSubject" (
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoSubject_pkey" PRIMARY KEY ("issuer","subject")
);

-- CreateIndex
CREATE UNIQUE INDEX "SsoConnection_orgId_key" ON "SsoConnection"("orgId");

-- CreateIndex
CREATE INDEX "SsoDomain_domain_idx" ON "SsoDomain"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "SsoDomain_orgId_domain_key" ON "SsoDomain"("orgId", "domain");

-- CreateIndex
CREATE INDEX "SsoSubject_userId_idx" ON "SsoSubject"("userId");

-- AddForeignKey
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoDomain" ADD CONSTRAINT "SsoDomain_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoState" ADD CONSTRAINT "SsoState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoSubject" ADD CONSTRAINT "SsoSubject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

