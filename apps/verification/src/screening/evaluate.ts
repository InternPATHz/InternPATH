import { detectContact } from './contact';
import { normalizeText } from './normalize';
import { findTermMatches } from './scan';
import type {
  Decision,
  Evaluation,
  EvaluationInput,
  JobContent,
  MatchedKeyword,
  Reason,
  RiskLevel,
  RiskRule,
  Rules,
} from './types';

const FIELDS = [
  'job_title',
  'description',
  'responsibilities',
  'qualifications',
  'allowance_text',
  'location',
  'contact_notes',
] as const;
/** README 5.1: คำต้องห้ามใน 2 ฟิลด์นี้ (ไม่ปฏิเสธ) = AUTO_REJECTED ทันที */
const MAIN_FIELDS: ReadonlySet<string> = new Set(['job_title', 'description']);

const DEFAULT_MAX_GAP = 12;
const LOW_BELOW = 20;
const HIGH_FROM = 70;

function normalizeContent(c: JobContent): JobContent {
  const out = { ...c } as JobContent;
  for (const f of FIELDS) {
    const v = c[f];
    if (typeof v === 'string') (out as unknown as Record<string, string>)[f] = normalizeText(v);
  }
  return out;
}

/**
 * ตัดสินประกาศงานตามลำดับใน spec §5.2 — ฟังก์ชันล้วน ไม่แตะ DB/Broker
 * 1) คำ HARD ที่ไม่ปฏิเสธใน job_title/description → AUTO_REJECT  2) score ≥ 70 → AUTO_REJECT
 * 3) คำ HARD เฉพาะรูปปฏิเสธ → PENDING_REVIEW  4) score 20–69 → PENDING_REVIEW
 * 5) score < 20 → APPROVE (ถ้าบริษัทติดธง UNDER_REVIEW → PENDING_REVIEW)
 */
export function evaluateJob(input: EvaluationInput, rules: Rules): Evaluation {
  const content = normalizeContent(input.content);
  const rule = (code: string): RiskRule | undefined => rules.riskRules.find((r) => r.code === code && r.enabled);
  const maxGap = rules.riskRules.find((r) => r.code === 'NEGATION_WINDOW')?.params.max_gap ?? DEFAULT_MAX_GAP;

  const severity = new Map(rules.blacklist.map((t) => [t.term, t]));
  const matched: MatchedKeyword[] = [];
  for (const field of FIELDS) {
    const text = content[field];
    if (typeof text !== 'string' || text === '') continue;
    // วนเพิ่มทีละตัว ไม่ใช้ push(...spread) — ผลจำนวนมากจะทำให้ call stack เต็ม (RangeError)
    for (const m of findTermMatches(text, field, rules.blacklist, rules.negationCues, maxGap)) matched.push(m);
  }
  const isHard = (m: MatchedKeyword) => severity.get(m.term)?.severity === 'HARD';

  const hardMain = matched.filter((m) => isHard(m) && MAIN_FIELDS.has(m.field));
  const hardMainActive = hardMain.filter((m) => !m.negated);
  const hardMainNegated = hardMain.filter((m) => m.negated);
  const hardOtherActive = matched.filter((m) => isHard(m) && !MAIN_FIELDS.has(m.field) && !m.negated);
  const negatedOnly = hardMain.length > 0 && hardMainActive.length === 0;

  const reasons: Reason[] = [];
  let score = 0;

  // เหตุผลต่อ "คำ" (ไม่ใช่ต่อครั้งที่ปรากฏ) — ซ้ำสามครั้งก็แสดง HR หนึ่งรายการ
  const seenHard = new Set<string>();
  for (const m of hardMainActive) {
    if (seenHard.has(m.term)) continue;
    seenHard.add(m.term);
    reasons.push({ code: 'BLACKLIST_HARD', detail: `พบคำต้องห้ามใน ${m.field}`, matched_text: m.term });
  }
  const seenNegated = new Set<string>();
  for (const m of hardMainNegated) {
    if (seenNegated.has(m.term)) continue;
    seenNegated.add(m.term);
    reasons.push({ code: 'BLACKLIST_NEGATED', detail: `พบคำต้องห้ามในประโยคปฏิเสธใน ${m.field} (ต้องให้ผู้ดูแลตรวจ)`, matched_text: m.term });
  }

  const contactRule = rule('CONTACT_IN_TEXT');
  if (contactRule) {
    for (const field of FIELDS) {
      const text = content[field];
      if (typeof text !== 'string') continue;
      const hit = detectContact(text)[0];
      if (hit) {
        score += contactRule.weight;
        reasons.push({ code: 'CONTACT_IN_TEXT', detail: `พบช่องทางติดต่อส่วนตัวใน ${field} (${hit.kind})`, matched_text: hit.matched });
        break;
      }
    }
  }

  const otherRule = rule('HARD_TERM_OTHER_FIELD');
  if (otherRule && hardOtherActive.length > 0) {
    score += otherRule.weight;
    reasons.push({
      code: 'HARD_TERM_OTHER_FIELD',
      detail: `พบคำต้องห้ามในฟิลด์ ${hardOtherActive[0].field}`,
      matched_text: hardOtherActive[0].term,
    });
  }

  const allowanceRule = rule('ALLOWANCE_HIGH');
  if (
    allowanceRule &&
    input.allowance.type === 'AMOUNT' &&
    (input.allowance.amount_thb ?? 0) > (allowanceRule.params.threshold_thb ?? Infinity)
  ) {
    score += allowanceRule.weight;
    reasons.push({ code: 'ALLOWANCE_HIGH', detail: 'เบี้ยเลี้ยงสูงผิดปกติสำหรับการฝึกงาน' });
  }

  const hoursRule = rule('HOURS_EXCESSIVE');
  if (hoursRule) {
    if (input.hours_per_week > (hoursRule.params.high_hours ?? Infinity)) {
      score += hoursRule.weight;
      reasons.push({ code: 'HOURS_EXCESSIVE', detail: 'ชั่วโมงฝึกต่อสัปดาห์สูงมาก' });
    } else if (input.hours_per_week > (hoursRule.params.mid_hours ?? Infinity)) {
      score += hoursRule.params.mid_weight ?? 0;
      reasons.push({ code: 'HOURS_EXCESSIVE', detail: 'ชั่วโมงฝึกต่อสัปดาห์สูงกว่าปกติ' });
    }
  }

  const shortRule = rule('DESCRIPTION_TOO_SHORT');
  if (shortRule && content.description.length < (shortRule.params.min_chars ?? 0)) {
    score += shortRule.weight;
    reasons.push({ code: 'DESCRIPTION_TOO_SHORT', detail: 'รายละเอียดงานสั้นเกินไป' });
  }

  const softRule = rule('SOFT_TERMS');
  if (softRule) {
    const distinct = new Map<string, number>();
    for (const m of matched) {
      const def = severity.get(m.term);
      if (def?.severity === 'SOFT' && !m.negated) distinct.set(m.term, def.weight ?? 0);
    }
    if (distinct.size > 0) {
      const sum = [...distinct.values()].reduce((a, b) => a + b, 0);
      score += Math.min(softRule.weight, sum);
      for (const term of distinct.keys()) {
        reasons.push({ code: 'BLACKLIST_SOFT', detail: 'พบถ้อยคำที่มักใช้ในประกาศหลอกลวง', matched_text: term });
      }
    }
  }

  const noAllowanceRule = rule('NO_ALLOWANCE');
  if (noAllowanceRule && input.allowance.type === 'NONE') {
    score += noAllowanceRule.weight;
    reasons.push({ code: 'NO_ALLOWANCE', detail: 'ไม่มีเบี้ยเลี้ยง' });
  }

  score = Math.min(100, score);

  let decision: Decision;
  let level: RiskLevel;
  if (hardMainActive.length > 0) {
    decision = 'AUTO_REJECT';
    level = 'HIGH';
    score = Math.max(score, HIGH_FROM); // คะแนนต้องไม่ขัดกับระดับที่แสดง
  } else if (score >= HIGH_FROM) {
    decision = 'AUTO_REJECT';
    level = 'HIGH';
    reasons.push({ code: 'SCORE_HIGH', detail: `คะแนนความเสี่ยง ${score} (เกณฑ์ปฏิเสธ ${HIGH_FROM})` });
  } else if (negatedOnly) {
    decision = 'PENDING_REVIEW';
    level = 'MEDIUM';
  } else if (score >= LOW_BELOW) {
    decision = 'PENDING_REVIEW';
    level = 'MEDIUM';
  } else if (input.company_flag_under_review) {
    decision = 'PENDING_REVIEW';
    level = 'LOW';
    reasons.push({ code: 'COMPANY_UNDER_REVIEW', detail: 'บริษัทอยู่ระหว่างตรวจสอบ ประกาศทุกฉบับต้องผ่านผู้ดูแล' });
  } else {
    decision = 'APPROVE';
    level = 'LOW';
  }

  return {
    risk_score: score,
    risk_level: level,
    decision,
    negated_only: negatedOnly,
    matched_keywords: matched,
    reasons,
    content,
  };
}
