-- CreateEnum
CREATE TYPE "CollageKind" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "AIJobKind" AS ENUM ('TRANSCRIBE_SEGMENT', 'TRANSCRIBE_CLIP', 'OCR_TICKER', 'GROUP_TICKERS', 'RENDER_COLLAGE');

-- CreateEnum
CREATE TYPE "AIJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AIJobPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateTable
CREATE TABLE "TickerEvent" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textNormalized" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "cropRect" JSONB NOT NULL,
    "imagePath" TEXT NOT NULL,
    "tickerGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TickerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TickerGroup" (
    "id" TEXT NOT NULL,
    "canonicalText" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "channelCount" INTEGER NOT NULL DEFAULT 0,
    "channels" TEXT[],
    "latestCollageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TickerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collage" (
    "id" TEXT NOT NULL,
    "kind" "CollageKind" NOT NULL DEFAULT 'AUTO',
    "tickerGroupId" TEXT,
    "imagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "eventIds" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Collage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIJob" (
    "id" TEXT NOT NULL,
    "kind" "AIJobKind" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "channelId" TEXT,
    "priority" "AIJobPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "AIJobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error" TEXT,
    "requestedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIFeedback" (
    "id" TEXT NOT NULL,
    "kind" "AIJobKind" NOT NULL,
    "channelId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION,
    "errorPct" DOUBLE PRECISION,
    "message" TEXT,

    CONSTRAINT "AIFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TickerEvent_channelId_startedAt_idx" ON "TickerEvent"("channelId", "startedAt");

-- CreateIndex
CREATE INDEX "TickerEvent_language_startedAt_idx" ON "TickerEvent"("language", "startedAt");

-- CreateIndex
CREATE INDEX "TickerEvent_tickerGroupId_idx" ON "TickerEvent"("tickerGroupId");

-- CreateIndex
CREATE INDEX "TickerEvent_textNormalized_idx" ON "TickerEvent"("textNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "TickerGroup_latestCollageId_key" ON "TickerGroup"("latestCollageId");

-- CreateIndex
CREATE INDEX "TickerGroup_lastSeenAt_idx" ON "TickerGroup"("lastSeenAt");

-- CreateIndex
CREATE INDEX "TickerGroup_language_idx" ON "TickerGroup"("language");

-- CreateIndex
CREATE INDEX "Collage_tickerGroupId_createdAt_idx" ON "Collage"("tickerGroupId", "createdAt");

-- CreateIndex
CREATE INDEX "Collage_createdAt_idx" ON "Collage"("createdAt");

-- CreateIndex
CREATE INDEX "AIJob_status_priority_createdAt_idx" ON "AIJob"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "AIJob_kind_status_idx" ON "AIJob"("kind", "status");

-- CreateIndex
CREATE INDEX "AIJob_channelId_kind_createdAt_idx" ON "AIJob"("channelId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AIJob_targetType_targetId_idx" ON "AIJob"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AIFeedback_kind_ranAt_idx" ON "AIFeedback"("kind", "ranAt");

-- CreateIndex
CREATE INDEX "AIFeedback_channelId_kind_ranAt_idx" ON "AIFeedback"("channelId", "kind", "ranAt");

-- AddForeignKey
ALTER TABLE "TickerEvent" ADD CONSTRAINT "TickerEvent_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TickerEvent" ADD CONSTRAINT "TickerEvent_tickerGroupId_fkey" FOREIGN KEY ("tickerGroupId") REFERENCES "TickerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TickerGroup" ADD CONSTRAINT "TickerGroup_latestCollageId_fkey" FOREIGN KEY ("latestCollageId") REFERENCES "Collage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collage" ADD CONSTRAINT "Collage_tickerGroupId_fkey" FOREIGN KEY ("tickerGroupId") REFERENCES "TickerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collage" ADD CONSTRAINT "Collage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
