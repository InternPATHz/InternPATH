-- รายงานพฤติกรรมนักศึกษาจากบริษัทถึงอาจารย์ (ผู้ใช้สั่ง 2026-11-26) — HR ส่งได้เฉพาะใบสมัคร IN_PROGRESS ของบริษัทตน
-- อาจารย์ผู้รับดูจาก applications.advisor_user_id ปัจจุบัน • ไม่เปลี่ยนสถานะใบสมัคร (ไม่มี status_history/E08)

CREATE TYPE "conduct_report_category" AS ENUM ('ATTENDANCE', 'BEHAVIOR', 'PERFORMANCE', 'SAFETY', 'OTHER');
CREATE TYPE "conduct_report_status" AS ENUM ('OPEN', 'ACKNOWLEDGED');

CREATE TABLE "conduct_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "student_user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "reported_by" UUID NOT NULL,
    "category" "conduct_report_category" NOT NULL,
    "detail" TEXT NOT NULL,
    "status" "conduct_report_status" NOT NULL DEFAULT 'OPEN',
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "advisor_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conduct_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conduct_reports_detail_check" CHECK (char_length("detail") BETWEEN 10 AND 2000),
    -- รับทราบแล้วต้องมีผู้รับทราบและเวลา
    CONSTRAINT "conduct_reports_ack_check" CHECK (
      ("status" = 'OPEN' AND "acknowledged_at" IS NULL) OR
      ("status" = 'ACKNOWLEDGED' AND "acknowledged_by" IS NOT NULL AND "acknowledged_at" IS NOT NULL))
);

CREATE INDEX "conduct_reports_application_id_created_at_idx" ON "conduct_reports"("application_id", "created_at");
CREATE INDEX "conduct_reports_status_created_at_idx" ON "conduct_reports"("status", "created_at");

ALTER TABLE "conduct_reports" ADD CONSTRAINT "conduct_reports_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
