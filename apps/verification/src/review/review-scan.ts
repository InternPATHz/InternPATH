import { detectContact } from '../screening/contact';
import { findTermMatches } from '../screening/scan';
import type { MatchedKeyword, Rules } from '../screening/types';

/** ชื่อฟิลด์เดียวของผลสแกนรีวิว (หัวข้อ+เนื้อหาต่อกันเป็นข้อความเดียว) */
export const REVIEW_FIELD = 'review';

const DEFAULT_MAX_GAP = 12;

export interface ReviewScan {
  hold: boolean;
  reasons: Array<{ code: 'BLACKLIST' | 'PERSONAL_CONTACT' }>;
  matched: MatchedKeyword[];
}

/** ข้อความที่ใช้สแกน/แสดง highlight: หัวข้อ (ถ้ามี) ตามด้วยบรรทัดใหม่และเนื้อหา */
export function reviewText(title: string | null | undefined, body: string): string {
  return title ? `${title}\n${body}` : body;
}

/**
 * สไลซ์ 3 §5.3 — ฟังก์ชันล้วน `text` ต้องผ่าน normalizeText แล้ว
 * พัก (hold) เมื่อเจอคำ HARD ที่ไม่ถูกประโยคปฏิเสธล้าง หรือเจอข้อมูลติดต่อส่วนตัว; คำ SOFT ไม่ทำให้พัก
 */
export function scanReview(text: string, rules: Rules): ReviewScan {
  const hard = rules.blacklist.filter((t) => t.severity === 'HARD');
  const maxGap = rules.riskRules.find((r) => r.code === 'NEGATION_WINDOW')?.params.max_gap ?? DEFAULT_MAX_GAP;
  const matched = findTermMatches(text, REVIEW_FIELD, hard, rules.negationCues, maxGap);

  const reasons: ReviewScan['reasons'] = [];
  if (matched.some((m) => !m.negated)) reasons.push({ code: 'BLACKLIST' });
  if (detectContact(text).length > 0) reasons.push({ code: 'PERSONAL_CONTACT' });
  return { hold: reasons.length > 0, reasons, matched };
}
