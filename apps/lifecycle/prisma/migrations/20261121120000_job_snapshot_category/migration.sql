-- ปรับ Requirement 2026-11-21: สายงานของประกาศ ใช้ตรวจสิทธิ์ HR Member ตามสายงาน (เติมจาก Internal job ตอนสมัคร/ตอนตรวจสิทธิ์)
CREATE TYPE "job_category" AS ENUM ('TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES');
ALTER TABLE "job_snapshots" ADD COLUMN "category" "job_category";
