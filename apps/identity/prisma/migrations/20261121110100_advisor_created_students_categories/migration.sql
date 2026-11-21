BEGIN;

-- ปรับ Requirement 2026-11-21: นักศึกษาไม่สมัครเอง (อาจารย์สร้างบัญชี) และ HR Member มีสายงาน
CREATE TYPE "job_category" AS ENUM ('TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES');

-- นักศึกษาที่อาจารย์สร้างยังไม่มีรหัสผ่านจนกว่าจะรับคำเชิญ
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- ถอดขั้น "นักศึกษาเลือกอาจารย์ → อาจารย์ยืนยัน": คำขอที่ค้างอยู่ถือว่ายกเลิก
UPDATE "student_profiles_identity"
   SET "advisor_link_status" = CASE WHEN "advisor_id" IS NULL THEN 'NONE'::"advisor_link_status" ELSE 'LINKED'::"advisor_link_status" END
 WHERE "advisor_link_status" = 'ADVISOR_LINK_PENDING';
ALTER TABLE "student_profiles_identity" DROP CONSTRAINT "student_profiles_identity_pending_advisor_id_fkey";
DROP INDEX "student_profiles_identity_pending_advisor_id_advisor_link_s_idx";
ALTER TABLE "student_profiles_identity" DROP COLUMN "pending_advisor_id";

ALTER TABLE "student_profiles_identity" ADD COLUMN "created_by_advisor_id" UUID;
ALTER TABLE "student_profiles_identity"
  ADD CONSTRAINT "student_profiles_identity_created_by_advisor_id_fkey"
  FOREIGN KEY ("created_by_advisor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- สายงานของ HR Member: สมาชิกเดิมได้ทุกสายงาน (ไม่ทำให้สิทธิ์เดิมหาย); OWNER ว่าง = ทุกสายงาน
ALTER TABLE "company_members" ADD COLUMN "categories" "job_category"[] NOT NULL DEFAULT ARRAY[]::"job_category"[];
ALTER TABLE "company_invitations" ADD COLUMN "categories" "job_category"[] NOT NULL DEFAULT ARRAY[]::"job_category"[];
UPDATE "company_members" SET "categories" = ARRAY['TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES']::"job_category"[]
 WHERE "member_role" = 'MEMBER';
UPDATE "company_invitations" SET "categories" = ARRAY['TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES']::"job_category"[];

COMMIT;
