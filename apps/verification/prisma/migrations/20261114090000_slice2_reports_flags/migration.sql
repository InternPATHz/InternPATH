-- สไลซ์ 2: รายงานประกาศ, ตัวนับ, ธงบริษัท, เหตุการณ์ปฏิเสธ (docs/superpowers/specs/2026-11-14-verification-slice2-design.md §5.2)

-- AlterEnum
ALTER TYPE "queue_origin" ADD VALUE 'REPORT_THRESHOLD';
ALTER TYPE "queue_origin" ADD VALUE 'REPORT_UNCOUNTED';
ALTER TYPE "queue_origin" ADD VALUE 'REJECTION_THRESHOLD';
ALTER TYPE "queue_origin" ADD VALUE 'ADMIN_FLAG';

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('OPEN', 'DISMISSED', 'UPHELD');

-- CreateEnum
CREATE TYPE "rejection_kind" AS ENUM ('AUTO_REJECTED', 'ADMIN_REJECTED', 'SUSPENDED', 'REMOVED');

-- CreateTable
CREATE TABLE "job_snapshots" (
    "job_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "entity_version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_snapshots_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "job_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "counted" BOOLEAN NOT NULL,
    "status" "report_status" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "job_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_report_counters" (
    "job_id" UUID NOT NULL,
    "counted_reports" INTEGER NOT NULL DEFAULT 0,
    "reset_at" TIMESTAMPTZ(6),
    "suspended_at" TIMESTAMPTZ(6),

    CONSTRAINT "job_report_counters_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "reporter_stats" (
    "user_id" UUID NOT NULL,
    "consecutive_dismissed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "reporter_stats_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "company_rejection_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "kind" "rejection_kind" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "source_event_id" UUID NOT NULL,

    CONSTRAINT "company_rejection_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_flags" (
    "company_id" UUID NOT NULL,
    "under_review" BOOLEAN NOT NULL DEFAULT false,
    "set_by" TEXT,
    "set_reason" TEXT,
    "set_at" TIMESTAMPTZ(6),
    "trigger_count" INTEGER,
    "cleared_by" UUID,
    "cleared_at" TIMESTAMPTZ(6),
    "entity_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "company_flags_pkey" PRIMARY KEY ("company_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_reports_job_id_reporter_user_id_key" ON "job_reports"("job_id", "reporter_user_id");

-- CreateIndex
CREATE INDEX "job_reports_reporter_user_id_created_at_idx" ON "job_reports"("reporter_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_rejection_events_source_event_id_key" ON "company_rejection_events"("source_event_id");

-- CreateIndex
CREATE INDEX "company_rejection_events_company_id_occurred_at_idx" ON "company_rejection_events"("company_id", "occurred_at");
