-- CreateEnum
CREATE TYPE "TickerKind" AS ENUM ('TICKER', 'FLASHER_LEFT', 'FLASHER_RIGHT');

-- DropIndex
DROP INDEX "TickerEvent_channelId_startedAt_idx";

-- DropIndex
DROP INDEX "TickerGroup_lastSeenAt_idx";

-- AlterTable
ALTER TABLE "TickerEvent" ADD COLUMN     "kind" "TickerKind" NOT NULL DEFAULT 'TICKER';

-- AlterTable
ALTER TABLE "TickerGroup" ADD COLUMN     "kind" "TickerKind" NOT NULL DEFAULT 'TICKER';

-- CreateIndex
CREATE INDEX "TickerEvent_channelId_kind_startedAt_idx" ON "TickerEvent"("channelId", "kind", "startedAt");

-- CreateIndex
CREATE INDEX "TickerEvent_kind_startedAt_idx" ON "TickerEvent"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "TickerGroup_kind_lastSeenAt_idx" ON "TickerGroup"("kind", "lastSeenAt");
