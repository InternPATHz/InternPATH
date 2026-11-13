-- ค่าตั้งต้นของกฎคัดกรอง (spec §5.3) — insert-if-missing: ไม่ทับค่าที่ Admin แก้ และรันซ้ำได้
-- ต้องตรงกับ src/screening/defaults.ts (มีเทสต์เทียบ)

INSERT INTO "blacklist_terms" ("term", "severity", "weight", "category") VALUES
  ('ค่ามัดจำ', 'HARD', NULL, 'FEE'),
  ('เงินมัดจำ', 'HARD', NULL, 'FEE'),
  ('ค่าสมัคร', 'HARD', NULL, 'FEE'),
  ('ค่าธรรมเนียม', 'HARD', NULL, 'FEE'),
  ('ค่าอบรม', 'HARD', NULL, 'FEE'),
  ('ค่าชุด', 'HARD', NULL, 'FEE'),
  ('ค่าประกัน', 'HARD', NULL, 'FEE'),
  ('โอนเงินก่อน', 'HARD', NULL, 'FEE'),
  ('ลงทุน', 'HARD', NULL, 'MLM_INVEST'),
  ('ดาวน์ไลน์', 'HARD', NULL, 'MLM_INVEST'),
  ('ขายตรง', 'HARD', NULL, 'MLM_INVEST'),
  ('แชร์ลูกโซ่', 'HARD', NULL, 'MLM_INVEST'),
  ('การันตีรายได้', 'HARD', NULL, 'MLM_INVEST'),
  ('mlm', 'HARD', NULL, 'MLM_INVEST'),
  ('พนัน', 'HARD', NULL, 'ILLEGAL'),
  ('บาคาร่า', 'HARD', NULL, 'ILLEGAL'),
  ('รหัส otp', 'HARD', NULL, 'SCAM'),
  ('ด่วน', 'SOFT', 10, 'PRESSURE'),
  ('รีบสมัคร', 'SOFT', 10, 'PRESSURE'),
  ('ที่นั่งจำกัด', 'SOFT', 10, 'PRESSURE'),
  ('รับทันที', 'SOFT', 10, 'PRESSURE'),
  ('รายได้ดี', 'SOFT', 10, 'PRESSURE'),
  ('รายได้ไม่จำกัด', 'SOFT', 15, 'PRESSURE')
ON CONFLICT ("term") DO NOTHING;

INSERT INTO "negation_cues" ("cue") VALUES
  ('ไม่มี'), ('ไม่เก็บ'), ('ไม่ต้อง'), ('ไม่คิด'), ('ไม่รับ'), ('no'), ('not'), ('without')
ON CONFLICT ("cue") DO NOTHING;

INSERT INTO "risk_rules" ("code", "weight", "params") VALUES
  ('CONTACT_IN_TEXT', 45, '{}'),
  ('HARD_TERM_OTHER_FIELD', 40, '{}'),
  ('ALLOWANCE_HIGH', 30, '{"threshold_thb": 30000}'),
  ('HOURS_EXCESSIVE', 25, '{"high_hours": 48, "mid_hours": 40, "mid_weight": 10}'),
  ('DESCRIPTION_TOO_SHORT', 15, '{"min_chars": 100}'),
  ('SOFT_TERMS', 30, '{}'),
  ('NO_ALLOWANCE', 5, '{}'),
  ('NEGATION_WINDOW', 0, '{"max_gap": 12}')
ON CONFLICT ("code") DO NOTHING;
