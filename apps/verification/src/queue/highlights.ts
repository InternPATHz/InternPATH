import type { MatchedKeyword } from '../screening/types';

export interface Highlight {
  field: string;
  start: number;
  end: number;
  keyword: string;
  negated: boolean;
}

/** แปลงผลสแกนเป็นไฮไลต์สำหรับหน้า Admin (ออฟเซ็ตอ้างอิง content ที่ API คืน ซึ่งผ่าน normalizeText แล้ว) */
export function buildHighlights(matched: MatchedKeyword[]): Highlight[] {
  return matched.map((m) => ({ field: m.field, start: m.start, end: m.end, keyword: m.term, negated: m.negated }));
}
