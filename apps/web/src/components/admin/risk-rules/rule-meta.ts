/**
 * คำอธิบายของกฎ Risk Score ที่ seed ไว้ใน Verification (ดู `apps/verification/src/screening/evaluate.ts`)
 * กฎและพารามิเตอร์ที่ไม่อยู่ในรายการนี้ยังแสดงและแก้ได้ (ใช้รหัสเป็นชื่อ) เพื่อไม่ให้กฎใหม่ในฐานข้อมูลหายไปจากหน้าจอ
 */
export type ParamMeta = { key: string; label: string; unit?: string; min?: number; max?: number };
export type RuleMeta = { name: string; description: string; weightHint?: string; params: ParamMeta[] };

export const RULE_META: Record<string, RuleMeta> = {
  CONTACT_IN_TEXT: {
    name: 'ช่องทางติดต่อส่วนตัวในข้อความ',
    description: 'พบเบอร์โทร อีเมล LINE หรือลิงก์โซเชียลในข้อความประกาศ',
    params: [],
  },
  HARD_TERM_OTHER_FIELD: {
    name: 'คำต้องห้ามแบบ HARD ในฟิลด์อื่น',
    description: 'พบคำ HARD ในฟิลด์ที่ไม่ใช่ชื่อตำแหน่ง/รายละเอียด (เพิ่มคะแนน ไม่ปฏิเสธทันที)',
    params: [],
  },
  ALLOWANCE_HIGH: {
    name: 'ค่าตอบแทนสูงผิดปกติ',
    description: 'ค่าตอบแทนต่อเดือนสูงกว่าเกณฑ์สำหรับการฝึกงาน',
    params: [{ key: 'threshold_thb', label: 'สูงกว่า', unit: 'บาท', min: 0 }],
  },
  HOURS_EXCESSIVE: {
    name: 'ชั่วโมงฝึกต่อสัปดาห์สูง',
    description: 'สูงกว่าเกณฑ์สูงมาก ⇒ เพิ่มคะแนนเต็ม; สูงกว่าเกณฑ์กลาง ⇒ เพิ่มตามน้ำหนักกลาง',
    params: [
      { key: 'high_hours', label: 'เกณฑ์สูงมาก (มากกว่า)', unit: 'ชม./สัปดาห์', min: 0 },
      { key: 'mid_hours', label: 'เกณฑ์กลาง (มากกว่า)', unit: 'ชม./สัปดาห์', min: 0 },
      { key: 'mid_weight', label: 'คะแนนของเกณฑ์กลาง', min: 0 },
    ],
  },
  DESCRIPTION_TOO_SHORT: {
    name: 'รายละเอียดงานสั้นเกินไป',
    description: 'ความยาวรายละเอียดงานน้อยกว่าเกณฑ์ (ไม่นับในช่องทดสอบข้อความ)',
    params: [{ key: 'min_chars', label: 'ขั้นต่ำ', unit: 'ตัวอักษร', min: 0 }],
  },
  SOFT_TERMS: {
    name: 'คำต้องห้ามแบบ SOFT',
    description: 'รวมน้ำหนักของคำ SOFT ที่พบ (คำละหนึ่งครั้ง ไม่นับคำในประโยคปฏิเสธ) น้ำหนักด้านล่างคือเพดานรวม',
    weightHint: 'เพดานรวม',
    params: [],
  },
  NO_ALLOWANCE: {
    name: 'ไม่มีเบี้ยเลี้ยง',
    description: 'ประกาศที่ไม่ระบุค่าตอบแทน',
    params: [],
  },
  NEGATION_WINDOW: {
    name: 'ช่วงตรวจประโยคปฏิเสธ',
    description: 'คำต้องห้ามที่อยู่หลังคำปฏิเสธไม่เกินระยะนี้ถือว่าอยู่ในประโยคปฏิเสธ (ไม่ใช่กฎคิดคะแนน)',
    weightHint: 'ไม่ใช้คะแนน',
    params: [{ key: 'max_gap', label: 'ระยะห่างสูงสุด', unit: 'ตัวอักษร', min: 0, max: 100 }],
  },
};

/** เกณฑ์แบ่งระดับความเสี่ยง (README §5.1.3) — ตายตัวในระบบ ไม่ได้แก้ผ่านหน้านี้ */
export const RISK_LEVEL_NOTES: Array<{ label: string; range: string; badge: string }> = [
  { label: 'ต่ำ', range: 'คะแนน < 20 และไม่พบคำต้องห้าม ⇒ เผยแพร่อัตโนมัติ', badge: 'bg-success-soft text-success-text' },
  { label: 'กลาง', range: 'คะแนน 20–69 ⇒ เข้าคิวให้ Admin ตรวจ', badge: 'bg-warning-soft text-warning-text' },
  { label: 'สูง', range: 'คะแนน ≥ 70 หรือพบคำต้องห้าม HARD ⇒ ปฏิเสธอัตโนมัติ', badge: 'bg-danger-soft text-danger-text' },
];
