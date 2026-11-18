-- รูปโปรไฟล์นักศึกษา (api-contract §7.1 PUT/DELETE /me/profile/photo, data-schema §6 — PM ตัดสิน 2026-11-18)
-- เก็บเฉพาะ Object Key ของ Private bucket; ไฟล์จริงอยู่ใน Storage
ALTER TABLE "student_profiles" ADD COLUMN "photo_key" TEXT;
