import type { Rules } from './types';

/**
 * ค่าตั้งต้นของกฎคัดกรอง (docs/superpowers/specs/2026-11-13-verification-slice1-design.md §5.3)
 * ต้องตรงกับ seed ใน prisma/migrations/*_seed_defaults — Admin ปรับได้ผ่าน /admin/blacklist และ /admin/risk-rules
 */
export const DEFAULT_RULES: Rules = {
  blacklist: [
    ...[
      'ค่ามัดจำ',
      'เงินมัดจำ',
      'ค่าสมัคร',
      'ค่าธรรมเนียม',
      'ค่าอบรม',
      'ค่าชุด',
      'ค่าประกัน',
      'โอนเงินก่อน',
      'ลงทุน',
      'ดาวน์ไลน์',
      'ขายตรง',
      'แชร์ลูกโซ่',
      'การันตีรายได้',
      'mlm',
      'พนัน',
      'บาคาร่า',
      'รหัส otp',
    ].map((term) => ({ term, severity: 'HARD' as const, weight: null })),
    { term: 'ด่วน', severity: 'SOFT', weight: 10 },
    { term: 'รีบสมัคร', severity: 'SOFT', weight: 10 },
    { term: 'ที่นั่งจำกัด', severity: 'SOFT', weight: 10 },
    { term: 'รับทันที', severity: 'SOFT', weight: 10 },
    { term: 'รายได้ดี', severity: 'SOFT', weight: 10 },
    { term: 'รายได้ไม่จำกัด', severity: 'SOFT', weight: 15 },
  ],
  negationCues: ['ไม่มี', 'ไม่เก็บ', 'ไม่ต้อง', 'ไม่คิด', 'ไม่รับ', 'no', 'not', 'without'],
  riskRules: [
    { code: 'CONTACT_IN_TEXT', weight: 45, params: {}, enabled: true },
    { code: 'HARD_TERM_OTHER_FIELD', weight: 40, params: {}, enabled: true },
    { code: 'ALLOWANCE_HIGH', weight: 30, params: { threshold_thb: 30000 }, enabled: true },
    { code: 'HOURS_EXCESSIVE', weight: 25, params: { high_hours: 48, mid_hours: 40, mid_weight: 10 }, enabled: true },
    { code: 'DESCRIPTION_TOO_SHORT', weight: 15, params: { min_chars: 100 }, enabled: true },
    { code: 'SOFT_TERMS', weight: 30, params: {}, enabled: true },
    { code: 'NO_ALLOWANCE', weight: 5, params: {}, enabled: true },
    { code: 'NEGATION_WINDOW', weight: 0, params: { max_gap: 12 }, enabled: true },
  ],
};
