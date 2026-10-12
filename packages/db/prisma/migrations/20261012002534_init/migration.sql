-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('queued', 'dialing', 'in_progress', 'analyzing', 'completed', 'no_answer', 'busy', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('not_sent', 'sending', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "CallSource" AS ENUM ('mcp', 'cli', 'sms', 'voice');

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "source" "CallSource" NOT NULL,
    "requester" TEXT NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'queued',
    "provider_call_id" TEXT,
    "to_number" TEXT NOT NULL,
    "recipient" TEXT,
    "task" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_seconds" DOUBLE PRECISION,
    "end_reason" TEXT,
    "error" TEXT,
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "outcome" JSONB,
    "finalize_lease" TIMESTAMP(3),
    "sms_status" "SmsStatus" NOT NULL DEFAULT 'not_sent',
    "sms_to" TEXT,
    "sms_error" TEXT,
    "sms_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_events" (
    "id" SERIAL NOT NULL,
    "call_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calls_idempotency_key_key" ON "calls"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "calls_provider_call_id_key" ON "calls"("provider_call_id");

-- CreateIndex
CREATE INDEX "calls_status_idx" ON "calls"("status");

-- CreateIndex
CREATE INDEX "calls_requester_created_at_idx" ON "calls"("requester", "created_at");

-- CreateIndex
CREATE INDEX "call_events_call_id_idx" ON "call_events"("call_id");

-- AddForeignKey
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
