/** คำต้องห้ามที่เจอหนึ่งครั้ง; `end` เป็น exclusive; ออฟเซ็ตอ้างอิงข้อความหลัง normalizeText */
export interface MatchedKeyword {
  term: string;
  field: string;
  negated: boolean;
  start: number;
  end: number;
}

export interface ContactMatch {
  kind: 'PHONE' | 'EMAIL' | 'LINE' | 'SOCIAL_LINK';
  start: number;
  end: number;
  matched: string;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Decision = 'APPROVE' | 'PENDING_REVIEW' | 'AUTO_REJECT';

export interface JobContent {
  job_title: string;
  description: string;
  responsibilities: string;
  qualifications: string;
  allowance_text: string;
  location: string;
  contact_notes?: string;
}

export interface EvaluationInput {
  content: JobContent;
  hours_per_week: number;
  /** amount_thb เป็นจำนวนเงินต่อเดือน */
  allowance: { type: 'AMOUNT' | 'NONE'; amount_thb?: number };
  company_flag_under_review: boolean;
}

export interface RiskRule {
  code: string;
  weight: number;
  params: Record<string, number>;
  enabled: boolean;
}

export interface Rules {
  blacklist: Array<{ term: string; severity: 'HARD' | 'SOFT'; weight: number | null }>;
  negationCues: string[];
  riskRules: RiskRule[];
}

export interface Reason {
  code: string;
  detail: string;
  matched_text?: string;
}

export interface Evaluation {
  risk_score: number;
  risk_level: RiskLevel;
  decision: Decision;
  negated_only: boolean;
  matched_keywords: MatchedKeyword[];
  reasons: Reason[];
  /** ข้อความหลัง normalizeText ทุกฟิลด์ — ออฟเซ็ตของ matched_keywords อ้างอิงข้อความนี้ */
  content: JobContent;
}
