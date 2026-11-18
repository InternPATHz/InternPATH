-- เวลาที่ Scheduler ตรวจว่าที่นั่งของใบที่ยืนยันแล้ว (สถานะหลัง start) ตรงกับ Job ล่าสุด (QIR-01/QIR-03 ขยายขอบเขตซ่อม)
-- ใช้ข้ามการตรวจซ้ำชั่วคราว (ตรวจใหม่ทุก 24 ชั่วโมง ไม่ข้ามถาวร) — NULL = ยังไม่เคยตรวจ/ไม่เกี่ยว (ใบที่ยัง RESERVED ตรวจทุกรอบ)
ALTER TABLE "applications" ADD COLUMN "quota_synced_at" TIMESTAMPTZ(6);
