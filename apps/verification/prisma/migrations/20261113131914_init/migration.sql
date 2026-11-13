-- CreateEnum
CREATE TYPE "risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "evaluation_decision" AS ENUM ('APPROVE', 'PENDING_REVIEW', 'AUTO_REJECT');

-- CreateEnum
CREATE TYPE "appeal_status" AS ENUM ('OPEN', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "queue_item_type" AS ENUM ('JOB_REVIEW', 'JOB_APPEAL', 'COMPANY_ACCOUNT', 'JOB_REPORT', 'REVIEW_HELD', 'REVIEW_REPORT');

-- CreateEnum
CREATE TYPE "queue_item_status" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED');

-- CreateEnum
CREATE TYPE "queue_priority" AS ENUM ('NORMAL', 'FAST_TRACK');

-- CreateEnum
CREATE TYPE "queue_origin" AS ENUM ('EVALUATION', 'VERIFY_TIMEOUT', 'APPEAL');

-- CreateEnum
CREATE TYPE "term_severity" AS ENUM ('HARD', 'SOFT');

-- CreateTable
CREATE TABLE "evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "submission_kind" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "content" JSONB NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "risk_level" "risk_level" NOT NULL,
    "decision" "evaluation_decision" NOT NULL,
    "negated_only" BOOLEAN NOT NULL,
    "matched_keywords" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "company_flag_under_review" BOOLEAN NOT NULL,
    "fast_track" BOOLEAN NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "status" "appeal_status" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "queue_item_type" NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "company_id" UUID,
    "submission_id" UUID,
    "priority" "queue_priority" NOT NULL DEFAULT 'NORMAL',
    "risk_level" "risk_level",
    "is_appeal" BOOLEAN NOT NULL DEFAULT false,
    "origin" "queue_origin" NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "queue_item_status" NOT NULL DEFAULT 'OPEN',
    "assigned_to" UUID,
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_snapshots" (
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entity_version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_snapshots_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "blacklist_terms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "term" TEXT NOT NULL,
    "severity" "term_severity" NOT NULL,
    "weight" INTEGER,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_rules" (
    "code" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_rules_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "negation_cues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cue" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "negation_cues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id","consumer")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_role" TEXT NOT NULL,
    "reason" TEXT,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "evaluations_submission_id_key" ON "evaluations"("submission_id");

-- CreateIndex
CREATE INDEX "evaluations_job_id_submitted_at_idx" ON "evaluations"("job_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "appeals_job_id_key" ON "appeals"("job_id");

-- CreateIndex
CREATE INDEX "queue_items_status_priority_due_at_idx" ON "queue_items"("status", "priority", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_terms_term_key" ON "blacklist_terms"("term");

-- CreateIndex
CREATE UNIQUE INDEX "negation_cues_cue_key" ON "negation_cues"("cue");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "status_history_entity_entity_id_occurred_at_idx" ON "status_history"("entity", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_occurred_at_idx" ON "admin_audit_log"("occurred_at");

-- ===== SQL มือ (Prisma ไม่รองรับ — ห้ามลบเมื่อสร้าง migration ใหม่) =====

-- รายการคิวที่เปิดอยู่ของ (target, type) เดียวกันซ้อนกันไม่ได้ (spec §5.4)
CREATE UNIQUE INDEX "queue_items_open_target_type_key"
  ON "queue_items" ("target_id", "type")
  WHERE "status" <> 'RESOLVED';

-- status_history และ admin_audit_log เป็น append-only (data-schema §2.2)
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "status_history_append_only"
  BEFORE UPDATE OR DELETE ON "status_history"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TRIGGER "admin_audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
