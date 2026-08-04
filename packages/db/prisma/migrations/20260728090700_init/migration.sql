-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "ChannelLanguage" AS ENUM ('EN', 'UR', 'AR', 'PA', 'OTHER');

-- CreateEnum
CREATE TYPE "ChannelCategory" AS ENUM ('NEWS', 'ENTERTAINMENT', 'SPORTS', 'MUSIC', 'RELIGIOUS', 'KIDS', 'BUSINESS', 'DOCUMENTARY', 'REGIONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('UDP', 'SRT', 'RTSP', 'RTMP', 'HLS', 'FILE');

-- CreateEnum
CREATE TYPE "DetectionKind" AS ENUM ('FACE', 'LOGO', 'TEXT', 'SCENE', 'AD_FINGERPRINT', 'OBJECT');

-- CreateEnum
CREATE TYPE "ClipFormat" AS ENUM ('MP4', 'MOV', 'MKV', 'WEBM');

-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('QUEUED', 'RENDERING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('KEYWORD', 'SOURCE_DOWN', 'SOURCE_SWITCH', 'DETECTION', 'DISK_LOW');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "mfaSecret" TEXT,
    "disabledAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "category" "ChannelCategory" NOT NULL DEFAULT 'NEWS',
    "language" "ChannelLanguage" NOT NULL DEFAULT 'UR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tickerCropRect" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL DEFAULT 'UDP',
    "url" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingSegment" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "sourceId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "resolution" TEXT,
    "codec" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordingSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingManifest" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "hourStart" TIMESTAMP(3) NOT NULL,
    "segmentIds" TEXT[],
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordingManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalHold" (
    "id" TEXT NOT NULL,
    "channelId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "words" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Detection" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "kind" "DetectionKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "tMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Detection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clip" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "watermarkText" TEXT,
    "format" "ClipFormat" NOT NULL DEFAULT 'MP4',
    "resolution" TEXT NOT NULL DEFAULT '1920x1080',
    "status" "ClipStatus" NOT NULL DEFAULT 'QUEUED',
    "path" TEXT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "channelId" TEXT,
    "kind" "AlertKind" NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 2,
    "matchedText" TEXT,
    "tMs" INTEGER,
    "payload" JSONB,
    "ackByUserId" TEXT,
    "ackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "text" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_slug_key" ON "Channel"("slug");

-- CreateIndex
CREATE INDEX "Channel_active_idx" ON "Channel"("active");

-- CreateIndex
CREATE INDEX "Channel_category_idx" ON "Channel"("category");

-- CreateIndex
CREATE INDEX "Channel_language_idx" ON "Channel"("language");

-- CreateIndex
CREATE INDEX "Source_channelId_isPrimary_idx" ON "Source"("channelId", "isPrimary");

-- CreateIndex
CREATE INDEX "Source_channelId_priority_idx" ON "Source"("channelId", "priority");

-- CreateIndex
CREATE INDEX "RecordingSegment_channelId_startedAt_idx" ON "RecordingSegment"("channelId", "startedAt");

-- CreateIndex
CREATE INDEX "RecordingSegment_startedAt_idx" ON "RecordingSegment"("startedAt");

-- CreateIndex
CREATE INDEX "RecordingManifest_hourStart_idx" ON "RecordingManifest"("hourStart");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingManifest_channelId_hourStart_key" ON "RecordingManifest"("channelId", "hourStart");

-- CreateIndex
CREATE INDEX "LegalHold_active_startsAt_endsAt_idx" ON "LegalHold"("active", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "LegalHold_channelId_active_idx" ON "LegalHold"("channelId", "active");

-- CreateIndex
CREATE INDEX "Transcript_segmentId_idx" ON "Transcript"("segmentId");

-- CreateIndex
CREATE INDEX "Transcript_language_idx" ON "Transcript"("language");

-- CreateIndex
CREATE INDEX "Detection_segmentId_kind_idx" ON "Detection"("segmentId", "kind");

-- CreateIndex
CREATE INDEX "Detection_kind_confidence_idx" ON "Detection"("kind", "confidence");

-- CreateIndex
CREATE INDEX "Clip_channelId_createdAt_idx" ON "Clip"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Clip_createdById_createdAt_idx" ON "Clip"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "Clip_status_idx" ON "Clip"("status");

-- CreateIndex
CREATE INDEX "Alert_channelId_createdAt_idx" ON "Alert"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_kind_createdAt_idx" ON "Alert"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_ackAt_idx" ON "Alert"("ackAt");

-- CreateIndex
CREATE INDEX "Keyword_active_idx" ON "Keyword"("active");

-- CreateIndex
CREATE INDEX "Keyword_text_idx" ON "Keyword"("text");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingManifest" ADD CONSTRAINT "RecordingManifest_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "RecordingSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Detection" ADD CONSTRAINT "Detection_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "RecordingSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
