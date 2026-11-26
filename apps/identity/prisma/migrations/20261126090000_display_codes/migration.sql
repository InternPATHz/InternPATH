BEGIN;

-- รหัสที่แสดงแทน UUID (UUID ยังเป็น key ภายในและใน event เหมือนเดิม)
-- นักศึกษา = student_code เดิม • บริษัท = registration_no เดิม • อาจารย์ = ตัวย่อมหาวิทยาลัย + เลข 6 หลัก
ALTER TABLE "universities" ADD COLUMN "abbreviation" TEXT;
CREATE UNIQUE INDEX "universities_abbreviation_key" ON "universities"("abbreviation");
ALTER TABLE "advisor_profiles" ADD COLUMN "advisor_code" TEXT;
CREATE UNIQUE INDEX "advisor_profiles_advisor_code_key" ON "advisor_profiles"("advisor_code");

-- ข้อมูลเดิม: ตัวย่อจากส่วนแรกของโดเมน (ซ้ำกันได้ ⇒ ต่อท้ายลำดับ) แล้วรหัสอาจารย์ = ตัวย่อ + ลำดับ 6 หลัก (ไม่สุ่ม เพื่อไม่ชนกัน)
WITH base AS (
  SELECT "id", left(upper(regexp_replace(split_part("email_domain", '.', 1), '[^A-Za-z0-9]', '', 'g')), 8) AS stem
    FROM "universities"
), numbered AS (
  SELECT "id", stem, row_number() OVER (PARTITION BY stem ORDER BY "id") AS n FROM base
)
UPDATE "universities" AS u
   SET "abbreviation" = CASE WHEN numbered.n = 1 AND numbered.stem <> '' THEN numbered.stem
                             ELSE coalesce(nullif(numbered.stem, ''), 'U') || numbered.n END
  FROM numbered
 WHERE numbered."id" = u."id";

WITH ranked AS (
  SELECT a."user_id", un."abbreviation",
         row_number() OVER (PARTITION BY un."id" ORDER BY a."created_at", a."user_id") AS n
    FROM "advisor_profiles" AS a
    JOIN "users" AS us ON us."id" = a."user_id"
    JOIN "universities" AS un ON un."id" = us."university_id"
)
UPDATE "advisor_profiles" AS a
   SET "advisor_code" = ranked."abbreviation" || lpad(ranked.n::text, 6, '0')
  FROM ranked
 WHERE ranked."user_id" = a."user_id";

COMMIT;
