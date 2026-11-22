BEGIN;

-- PM ตัดสิน 2026-11-22: รหัสนักศึกษาห้ามซ้ำในสถาบันเดียวกันระดับ DB ด้วย (กันคำขอพร้อมกันที่หลุดการเช็กระดับ API)
-- unique ข้ามตารางไม่ได้ จึงเก็บสำเนา users.university_id ไว้ที่โปรไฟล์นักศึกษา
ALTER TABLE "student_profiles_identity" ADD COLUMN "university_id" UUID;

UPDATE "student_profiles_identity" AS s
   SET "university_id" = u."university_id"
  FROM "users" AS u
 WHERE u."id" = s."user_id";

-- ไม่แก้ข้อมูลอัตโนมัติ: ถ้ามีนักศึกษาไม่มีสถาบัน หรือรหัสซ้ำในสถาบันเดียวกัน ให้ migration ล้มพร้อมบอกจำนวน แล้วให้คนตัดสินใจแก้ข้อมูลเอง
DO $$
DECLARE
  missing integer;
  duplicated integer;
BEGIN
  SELECT count(*) INTO missing FROM "student_profiles_identity" WHERE "university_id" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'student_profiles_identity: % row(s) have no university (users.university_id IS NULL); fix data before this migration', missing;
  END IF;
  SELECT count(*) INTO duplicated FROM (
    SELECT 1 FROM "student_profiles_identity" GROUP BY "university_id", "student_code" HAVING count(*) > 1
  ) AS d;
  IF duplicated > 0 THEN
    RAISE EXCEPTION 'student_profiles_identity: % duplicated (university_id, student_code) pair(s); fix data before this migration', duplicated;
  END IF;
END $$;

ALTER TABLE "student_profiles_identity" ALTER COLUMN "university_id" SET NOT NULL;

ALTER TABLE "student_profiles_identity"
  ADD CONSTRAINT "student_profiles_identity_university_id_fkey"
  FOREIGN KEY ("university_id") REFERENCES "universities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "student_profiles_identity_university_id_student_code_key"
  ON "student_profiles_identity"("university_id", "student_code");

COMMIT;
