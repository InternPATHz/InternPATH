-- ADVISOR_LINK_PENDING เลิกใช้ (2026-11-21; PM ตัดสิน 2026-11-22): Identity แปลงแถว pending ของตัวเองไปแล้ว
-- (migration 20261121110100 ของ Identity) แต่ไม่ได้ส่ง E07 ออกมา ⇒ แปลงแถวค้างของ Lifecycle ให้ผลตรงกัน
-- มีอาจารย์ (อาจารย์เดิม = advisor_id ฝั่ง Identity) ⇒ LINKED, ไม่มี ⇒ NONE
-- อ่าน/เขียนเฉพาะตารางของ Lifecycle • ไม่แตะ entity_version (E07 ถัดไปจาก Identity ยังใช้ได้) • รันซ้ำได้ (แถวที่แปลงแล้วไม่ตรง WHERE)
-- ค่า ADVISOR_LINK_PENDING ยังอยู่ใน enum advisor_link_status เป็นค่าสงวน (Postgres ถอดค่าออกจาก enum ตรง ๆ ไม่ได้)
UPDATE "student_advisor_links"
   SET "link_status" = CASE WHEN "advisor_user_id" IS NULL THEN 'NONE'::"advisor_link_status" ELSE 'LINKED'::"advisor_link_status" END,
       "updated_at" = now()
 WHERE "link_status" = 'ADVISOR_LINK_PENDING';
