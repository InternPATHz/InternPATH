-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('PENDING', 'NEED_MORE_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "advisor_link_status" AS ENUM ('NONE', 'ADVISOR_LINK_PENDING', 'LINKED');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('DRAFT', 'VERIFYING', 'PUBLISHED', 'PENDING_REVIEW', 'AUTO_REJECTED', 'ADMIN_REJECTED', 'SUSPENDED', 'REMOVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('PENDING', 'HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED', 'IN_PROGRESS', 'EVALUATED_PASS', 'EVALUATED_FAIL', 'FAIL_DISPUTED', 'REEVALUATION_REQUESTED', 'COMPLETED', 'TERMINATED', 'NO_EVALUATION', 'HR_REJECTED', 'STUDENT_DECLINED', 'ADVISOR_REJECTED', 'OFFER_RESCINDED', 'WITHDRAWN', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "academic_result" AS ENUM ('ACADEMIC_PASS', 'ACADEMIC_FAIL', 'REPEAT_REQUIRED');

-- CreateEnum
CREATE TYPE "terminated_by" AS ENUM ('COMPANY', 'STUDENT', 'ADVISOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "certificate_status" AS ENUM ('VALID', 'REVOKED');

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('SUBMITTED', 'PUBLISHED', 'HELD', 'REMOVED');

-- CreateEnum
CREATE TYPE "problem_report_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "company_suspended_decision" AS ENUM ('PENDING', 'CONTINUE', 'TERMINATE');

-- CreateEnum
CREATE TYPE "evaluation_result" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "dispute_decision" AS ENUM ('REEVALUATE', 'UPHOLD');

-- CreateEnum
CREATE TYPE "review_outcome_label" AS ENUM ('PASS', 'FAIL', 'TERMINATED', 'NO_EVALUATION');

-- CreateEnum
CREATE TYPE "problem_report_category" AS ENUM ('WORKLOAD_OR_HOURS', 'NO_ALLOWANCE_AS_PROMISED', 'UNSAFE_OR_HARASSMENT', 'DIFFERENT_FROM_JOB_POST', 'OTHER');

-- CreateEnum
CREATE TYPE "problem_follow_up_action" AS ENUM ('MONITOR_COMPANY', 'TERMINATE', 'ESCALATE_COMPANY_REVIEW');

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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

-- CreateTable
CREATE TABLE "student_profiles" (
    "user_id" UUID NOT NULL,
    "headline" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bio" TEXT,
    "portfolio_url" TEXT,
    "major" TEXT NOT NULL,
    "year_level" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_user_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'application/pdf',
    "size_bytes" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_advisor_links" (
    "student_user_id" UUID NOT NULL,
    "advisor_user_id" UUID,
    "link_status" "advisor_link_status" NOT NULL DEFAULT 'NONE',
    "entity_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_advisor_links_pkey" PRIMARY KEY ("student_user_id")
);

-- CreateTable
CREATE TABLE "company_snapshots" (
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logo_key" TEXT,
    "status" "company_status" NOT NULL,
    "university_partner" BOOLEAN NOT NULL DEFAULT false,
    "entity_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_snapshots_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "job_snapshots" (
    "job_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "status" "job_status" NOT NULL,
    "target_majors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "entity_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_snapshots_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "advisor_user_id" UUID,
    "resume_id" UUID,
    "resume_consent_id" UUID,
    "cover_letter" TEXT,
    "major_mismatch" BOOLEAN NOT NULL DEFAULT false,
    "status" "application_status" NOT NULL DEFAULT 'PENDING',
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "frozen_at" TIMESTAMPTZ(6),
    "sla_paused_seconds" INTEGER NOT NULL DEFAULT 0,
    "company_suspended_decision" "company_suspended_decision",
    "flagged_for_advisor" BOOLEAN NOT NULL DEFAULT false,
    "start_date" DATE,
    "end_date" DATE,
    "actual_start_date" DATE,
    "actual_end_date" DATE,
    "quota_reserved" BOOLEAN NOT NULL DEFAULT false,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminated_by" "terminated_by",
    "terminate_reason" TEXT,
    "withdrawn_reason" TEXT,
    "rescind_reason" TEXT,
    "advisor_reject_reason" TEXT,
    "academic_result" "academic_result",
    "academic_note" TEXT,
    "academic_recorded_at" TIMESTAMPTZ(6),
    "reevaluation_used" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "entity_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "result" "evaluation_result" NOT NULL,
    "reason" TEXT,
    "score_note" TEXT,
    "evaluated_by" UUID NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fail_disputes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "dispute_decision",
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fail_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "certificate_code" TEXT NOT NULL,
    "application_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "holder_name_snapshot" TEXT NOT NULL,
    "company_name_snapshot" TEXT NOT NULL,
    "job_title_snapshot" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "actual_days" INTEGER NOT NULL,
    "pdf_object_key" TEXT NOT NULL,
    "pdf_sha256" VARCHAR(64) NOT NULL,
    "status" "certificate_status" NOT NULL DEFAULT 'VALID',
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" UUID,
    "revoked_by_role" TEXT,
    "revoke_reason" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "display_major" TEXT,
    "display_year" INTEGER,
    "outcome_label" "review_outcome_label" NOT NULL,
    "status" "review_status" NOT NULL DEFAULT 'SUBMITTED',
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_replies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "replied_by" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_review_stats" (
    "company_id" UUID NOT NULL,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "entity_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_review_stats_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "problem_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "advisor_user_id" UUID,
    "category" "problem_report_category" NOT NULL,
    "detail" TEXT NOT NULL,
    "status" "problem_report_status" NOT NULL DEFAULT 'OPEN',
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "follow_up_action" "problem_follow_up_action",
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reapply_unlocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_user_id" UUID NOT NULL,
    "unlocked_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "reapply_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_overrides" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_overrides_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "status_history_entity_entity_id_occurred_at_idx" ON "status_history"("entity", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_target_type_target_id_idx" ON "admin_audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "admin_audit_log_occurred_at_idx" ON "admin_audit_log"("occurred_at");

-- CreateIndex
CREATE INDEX "resumes_student_user_id_idx" ON "resumes"("student_user_id");

-- CreateIndex
CREATE INDEX "applications_status_status_changed_at_idx" ON "applications"("status", "status_changed_at");

-- CreateIndex
CREATE INDEX "applications_advisor_user_id_status_idx" ON "applications"("advisor_user_id", "status");

-- CreateIndex
CREATE INDEX "applications_company_id_status_idx" ON "applications"("company_id", "status");

-- CreateIndex
CREATE INDEX "applications_student_user_id_status_idx" ON "applications"("student_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "evaluations_application_id_round_key" ON "evaluations"("application_id", "round");

-- CreateIndex
CREATE INDEX "fail_disputes_application_id_idx" ON "fail_disputes"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_certificate_code_key" ON "certificates"("certificate_code");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_application_id_key" ON "certificates"("application_id");

-- CreateIndex
CREATE INDEX "certificates_student_user_id_idx" ON "certificates"("student_user_id");

-- CreateIndex
CREATE INDEX "certificates_company_id_idx" ON "certificates"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_application_id_key" ON "reviews"("application_id");

-- CreateIndex
CREATE INDEX "reviews_company_id_status_idx" ON "reviews"("company_id", "status");

-- CreateIndex
CREATE INDEX "reviews_student_user_id_idx" ON "reviews"("student_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_replies_review_id_key" ON "review_replies"("review_id");

-- CreateIndex
CREATE INDEX "problem_reports_advisor_user_id_status_idx" ON "problem_reports"("advisor_user_id", "status");

-- CreateIndex
CREATE INDEX "problem_reports_status_due_at_idx" ON "problem_reports"("status", "due_at");

-- CreateIndex
CREATE INDEX "reapply_unlocks_student_user_id_idx" ON "reapply_unlocks"("student_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_log_entity_id_type_due_date_key" ON "reminder_log"("entity_id", "type", "due_date");

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fail_disputes" ADD CONSTRAINT "fail_disputes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- SQL มือ (Manual SQL): Constraints & Append-Only Triggers
-- =============================================================================

-- นักศึกษายืนยันได้ทีละ 1 ที่ (README 5.2.2, data-schema §6)
CREATE UNIQUE INDEX "applications_one_active_confirmation_per_student"
  ON "applications" ("student_user_id")
  WHERE "status" IN ('ADVISOR_PENDING', 'ADVISOR_APPROVED', 'IN_PROGRESS');

-- ไม่สมัครซ้ำประกาศเดิมที่ยังดำเนินอยู่ (data-schema §6)
CREATE UNIQUE INDEX "applications_no_duplicate_active_per_job"
  ON "applications" ("student_user_id", "job_id")
  WHERE "status" NOT IN (
    'HR_REJECTED',
    'STUDENT_DECLINED',
    'ADVISOR_REJECTED',
    'OFFER_RESCINDED',
    'WITHDRAWN',
    'EXPIRED',
    'CANCELLED',
    'TERMINATED',
    'NO_EVALUATION',
    'COMPLETED'
  );

-- ระยะฝึกจริงต้องไม่น้อยกว่า 30 วัน (README 5.2.2, 5.4, data-schema §6)
ALTER TABLE "certificates"
  ADD CONSTRAINT "certificates_actual_days_check"
  CHECK ("actual_days" >= 30);

-- evaluations.round ต้องเป็น 1 หรือ 2 (data-schema §6)
ALTER TABLE "evaluations"
  ADD CONSTRAINT "evaluations_round_check"
  CHECK ("round" IN (1, 2));

-- evaluations.reason บังคับเมื่อ result = 'FAIL' (README §5.2.2, data-schema §6)
ALTER TABLE "evaluations"
  ADD CONSTRAINT "evaluations_reason_required_on_fail"
  CHECK ("result" <> 'FAIL' OR ("reason" IS NOT NULL AND length(trim("reason")) > 0));

-- reviews.rating ต้องอยู่ระหว่าง 1 ถึง 5 (data-schema §6)
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_rating_range_check"
  CHECK ("rating" BETWEEN 1 AND 5);

-- ประวัติการเปลี่ยนสถานะและ audit log เป็น append-only (README 5.10, data-schema §2.2)
-- ยอมให้ UPDATE ได้เฉพาะ Authorized Anonymization Operation (data-schema §2.3):
-- คอลัมน์ actor_id/admin_id เท่านั้น และต้องเปลี่ยนเป็น internpath.anonymous_actor_id
-- ภายใน Transaction ที่ตั้งทั้ง internpath.anonymize = 'on' และ internpath.anonymous_actor_id
CREATE OR REPLACE FUNCTION forbid_lifecycle_history_change() RETURNS trigger AS $$
DECLARE
  actor_column text;
  anonymous_actor_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('internpath.anonymize', true) = 'on' THEN
    actor_column := CASE TG_TABLE_NAME
      WHEN 'status_history' THEN 'actor_id'
      WHEN 'admin_audit_log' THEN 'admin_id'
      ELSE NULL
    END;
    anonymous_actor_id := NULLIF(current_setting('internpath.anonymous_actor_id', true), '')::uuid;

    IF actor_column IS NOT NULL
       AND anonymous_actor_id IS NOT NULL
       AND (to_jsonb(OLD) ->> actor_column) IS NOT NULL
       AND (to_jsonb(NEW) ->> actor_column)::uuid = anonymous_actor_id
       AND (to_jsonb(NEW) ->> actor_column) IS DISTINCT FROM (to_jsonb(OLD) ->> actor_column)
       AND (to_jsonb(NEW) - actor_column) = (to_jsonb(OLD) - actor_column)
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "status_history_append_only"
  BEFORE UPDATE OR DELETE ON "status_history"
  FOR EACH ROW EXECUTE FUNCTION forbid_lifecycle_history_change();

CREATE TRIGGER "admin_audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_lifecycle_history_change();
