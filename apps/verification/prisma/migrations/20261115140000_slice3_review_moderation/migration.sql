-- สไลซ์ 3: ตรวจรีวิวและรายงานรีวิว (spec 2026-11-15-verification-slice3-design §5.2)
ALTER TYPE "queue_origin" ADD VALUE 'REVIEW_SCAN';
ALTER TYPE "queue_origin" ADD VALUE 'REVIEW_REPORT';

CREATE TYPE "review_moderation_status" AS ENUM ('PASSED', 'HELD', 'ADMIN_PUBLISHED', 'ADMIN_REMOVED');

CREATE TABLE "review_moderations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "rating" SMALLINT NOT NULL,
    "outcome_label" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "status" "review_moderation_status" NOT NULL,
    "queue_item_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_moderations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_moderations_review_id_key" ON "review_moderations"("review_id");

CREATE TABLE "review_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_reports_review_id_reporter_user_id_key" ON "review_reports"("review_id", "reporter_user_id");
