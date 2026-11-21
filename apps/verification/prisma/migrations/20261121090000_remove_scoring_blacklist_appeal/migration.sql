-- ปรับ Requirement 2026-11-21: ตัดคำต้องห้าม/คะแนนความเสี่ยง/อุทธรณ์ — Verification เหลือคิว Admin, รายงาน, ธงบริษัท
-- ค่า enum เก่า (JOB_APPEAL, REVIEW_HELD, EVALUATION, APPEAL, REVIEW_SCAN, AUTO_REJECTED) คงไว้เป็นค่าที่เลิกใช้ เพื่อไม่ต้องรื้อ type ใน Postgres

ALTER TYPE "queue_origin" ADD VALUE IF NOT EXISTS 'FLAGGED_COMPANY';

-- รายการคิวที่เปิดค้างของชนิดที่เลิกใช้ ปิดทิ้งเพื่อไม่ให้ค้างโดยไม่มีทางตัดสิน
UPDATE "queue_items" SET "status" = 'RESOLVED', "resolution" = 'RETIRED', "resolved_at" = now()
 WHERE "status" <> 'RESOLVED' AND "type" IN ('JOB_APPEAL', 'REVIEW_HELD');

-- หมายเหตุ: รีวิวสถานะ HELD ที่ค้างอยู่ (ถ้ามี — ข้อมูลทดสอบในเครื่อง) ต้องให้ Admin ตัดสินก่อน migrate เพราะรายการ REVIEW_HELD ถูกปิดด้วย RETIRED

ALTER TABLE "queue_items" DROP COLUMN "risk_level", DROP COLUMN "is_appeal";

DROP TABLE "appeals";
DROP TABLE "blacklist_terms";
DROP TABLE "negation_cues";
DROP TABLE "risk_rules";

ALTER TABLE "evaluations"
  DROP COLUMN "risk_score",
  DROP COLUMN "risk_level",
  DROP COLUMN "decision",
  DROP COLUMN "negated_only",
  DROP COLUMN "matched_keywords",
  DROP COLUMN "reasons",
  DROP COLUMN "company_flag_under_review",
  DROP COLUMN "evaluated_at";
ALTER TABLE "evaluations" ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();
ALTER TABLE "evaluations" RENAME TO "job_submission_snapshots";
ALTER TABLE "job_submission_snapshots" RENAME CONSTRAINT "evaluations_pkey" TO "job_submission_snapshots_pkey";
ALTER INDEX "evaluations_submission_id_key" RENAME TO "job_submission_snapshots_submission_id_key";
ALTER INDEX "evaluations_job_id_submitted_at_idx" RENAME TO "job_submission_snapshots_job_id_submitted_at_idx";

DROP TYPE "evaluation_decision";
DROP TYPE "appeal_status";
DROP TYPE "term_severity";
DROP TYPE "risk_level";
