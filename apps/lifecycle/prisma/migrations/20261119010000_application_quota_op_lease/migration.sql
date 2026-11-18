-- Lease กันคำสั่งที่จอง/คืนโควตาของใบสมัครเดียวกันซ้อนกัน (QIR-01: accept ซ้อนกับ compensation release ที่ยังค้าง)
-- ใช้เฉพาะ Lifecycle: NULL = ไม่มีคำสั่งค้าง; ค่า <= now() = หมดอายุแล้ว (ถือว่าว่าง)
ALTER TABLE "applications" ADD COLUMN "quota_op_until" TIMESTAMPTZ(6);
