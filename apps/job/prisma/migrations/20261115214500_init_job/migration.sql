BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('DRAFT', 'VERIFYING', 'PUBLISHED', 'PENDING_REVIEW', 'AUTO_REJECTED', 'ADMIN_REJECTED', 'SUSPENDED', 'REMOVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "work_mode" AS ENUM ('ONSITE', 'REMOTE', 'HYBRID');

-- CreateEnum
CREATE TYPE "job_category" AS ENUM ('TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES');

-- CreateEnum
CREATE TYPE "quota_reservation_status" AS ENUM ('RESERVED', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('PENDING', 'NEED_MORE_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "allowance_type" AS ENUM ('AMOUNT', 'NONE');

-- CreateEnum
CREATE TYPE "job_submission_kind" AS ENUM ('NEW', 'EDIT', 'RESUBMIT');

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "category" "job_category",
    "job_title" TEXT,
    "description" TEXT,
    "responsibilities" TEXT,
    "qualifications" TEXT,
    "allowance_type" "allowance_type",
    "allowance_amount_thb" INTEGER,
    "allowance_text" TEXT,
    "location" TEXT,
    "contact_notes" TEXT,
    "work_mode" "work_mode",
    "hours_per_week" INTEGER,
    "internship_period_start" DATE,
    "internship_period_end" DATE,
    "target_majors" TEXT[],
    "quota" INTEGER,
    "quota_reserved" INTEGER DEFAULT 0,
    "quota_confirmed" INTEGER DEFAULT 0,
    "status" "job_status" NOT NULL,
    "suspended_from_status" "job_status",
    "featured" BOOLEAN DEFAULT false,
    "current_submission_id" UUID,
    "verifying_since" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "application_deadline" DATE,
    "entity_version" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "kind" "job_submission_kind" NOT NULL,
    "changed_fields" TEXT[],
    "submitted_by" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "result_decision" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_reservations" (
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "status" "quota_reservation_status" NOT NULL,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "release_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_reservations_pkey" PRIMARY KEY ("application_id")
);

-- CreateTable
CREATE TABLE "company_snapshots" (
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logo_key" TEXT,
    "status" "company_status" NOT NULL,
    "university_partner" BOOLEAN NOT NULL,
    "verified_badge" BOOLEAN NOT NULL,
    "entity_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_snapshots_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "company_entitlements" (
    "company_id" UUID NOT NULL,
    "featured_enabled" BOOLEAN NOT NULL,
    "fast_track_enabled" BOOLEAN NOT NULL,
    "entity_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_entitlements_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "company_flags" (
    "company_id" UUID NOT NULL,
    "under_review" BOOLEAN NOT NULL,
    "entity_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_flags_pkey" PRIMARY KEY ("company_id")
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

-- CreateIndex
CREATE INDEX "jobs_status_featured_published_at_idx" ON "jobs"("status", "featured" DESC, "published_at" DESC);

-- CreateIndex
CREATE INDEX "jobs_target_majors_idx" ON "jobs" USING GIN ("target_majors");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "status_history_entity_entity_id_occurred_at_idx" ON "status_history"("entity", "entity_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "job_submissions" ADD CONSTRAINT "job_submissions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Handwritten SQL (docs/data-schema.md §2.2, §2.3, §4).
-- Preserve these CHECKs, the partial index, and the trigger in future migrations.
-- CHECK normally accepts UNKNOWN (NULL); IS TRUE makes missing required values fail.
-- DRAFT content can remain incomplete, including an unfinished AMOUNT allowance.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_non_draft_complete_check" CHECK ((
  "status" = 'DRAFT' OR (
    "category" IS NOT NULL
    AND "job_title" IS NOT NULL
    AND "description" IS NOT NULL
    AND "responsibilities" IS NOT NULL
    AND "qualifications" IS NOT NULL
    AND "location" IS NOT NULL
    AND "work_mode" IS NOT NULL
    AND "hours_per_week" IS NOT NULL
    AND "allowance_type" IS NOT NULL
    AND ("allowance_type" = 'NONE' OR (
      "allowance_amount_thb" IS NOT NULL AND "allowance_amount_thb" > 0
    ))
    AND "internship_period_start" IS NOT NULL
    AND "internship_period_end" IS NOT NULL
    AND "target_majors" IS NOT NULL
    AND cardinality("target_majors") >= 1
    AND "quota" IS NOT NULL AND "quota" >= 1
    AND "application_deadline" IS NOT NULL
  )
) IS TRUE);

-- Prisma String[] cannot decode NULL elements, even on DRAFT records.
-- A whole NULL array has no matching element and remains allowed on DRAFT.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_target_majors_no_null_elements_check"
  CHECK (array_position("target_majors", NULL) IS NULL);

-- Keep Phase 1A's nullable DRAFT fields. A missing quota is allowed only on DRAFT
-- by the completeness CHECK; once quota is set, both counters must be known.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_quota_reserved_nonnegative_check"
  CHECK ("quota_reserved" IS NULL OR "quota_reserved" >= 0);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_quota_confirmed_nonnegative_check"
  CHECK ("quota_confirmed" IS NULL OR "quota_confirmed" >= 0);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_quota_capacity_check" CHECK (
  "quota" IS NULL OR (
    "quota_reserved"::bigint + "quota_confirmed"::bigint <= "quota"::bigint
  ) IS TRUE
);

CREATE INDEX "outbox_events_pending_created_at_idx"
  ON "outbox_events" ("created_at") WHERE "published_at" IS NULL;

-- Same authorized anonymization pattern as Identity and Verification.
-- The handler sets both custom settings with set_config(..., true) in its transaction.
CREATE FUNCTION forbid_job_history_change() RETURNS trigger AS $$
DECLARE
  anonymous_actor_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('internpath.anonymize', true) = 'on' THEN
    anonymous_actor_id := NULLIF(current_setting('internpath.anonymous_actor_id', true), '')::uuid;

    IF anonymous_actor_id IS NOT NULL
       AND OLD.actor_id IS NOT NULL
       AND NEW.actor_id = anonymous_actor_id
       AND NEW.actor_id IS DISTINCT FROM OLD.actor_id
       AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id')
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "status_history_append_only"
  BEFORE UPDATE OR DELETE ON "status_history"
  FOR EACH ROW EXECUTE FUNCTION forbid_job_history_change();

COMMIT;
