import type { MatchedKeyword } from './types';

export type { MatchedKeyword } from './types';

const SENTENCE_BREAK = /[\n.!?;]/;
/** จำนวนผลสูงสุดต่อคำต่อฟิลด์ ต่อแบบ (ปฏิเสธ / ไม่ปฏิเสธ) */
const MAX_PER_TERM = 100;
const ASCII_WORD = /^[a-z]+$/;
const LETTER = /[a-z]/;

/** ตัวพิมพ์เล็กโดยคงความยาวเดิมเสมอ (ให้ออฟเซ็ตตรงกับข้อความต้นฉบับ) */
function lowerKeepLength(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (const ch of text) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** ตำแหน่งเริ่มประโยคทั้งหมด (คำนวณครั้งเดียวต่อข้อความ เพื่อไม่ให้ช้าเมื่อมีคำซ้ำจำนวนมาก) */
function sentenceStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_BREAK.test(text[i])) starts.push(i + 1);
  }
  return starts;
}

function sentenceStartOf(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return starts[lo];
}

/** cue ภาษาอังกฤษต้องเป็นคำเต็ม (กัน "casino" ถูกนับเป็น "no") */
function cueMatchesAt(window: string, idx: number, cue: string): boolean {
  if (!ASCII_WORD.test(cue)) return true;
  const before = idx > 0 ? window[idx - 1] : '';
  const after = window[idx + cue.length] ?? '';
  return !(before && LETTER.test(before)) && !(after && LETTER.test(after));
}

/**
 * หาทุกตำแหน่งที่ปรากฏของคำต้องห้ามในข้อความ (substring ไม่สนตัวพิมพ์) พร้อมระบุว่าอยู่ในประโยคปฏิเสธหรือไม่
 * ปฏิเสธ = มี cue ก่อนคำในประโยคเดียวกัน และระยะจากท้าย cue ถึงต้นคำ ≤ maxGap ตัวอักษร
 * (ประโยคแบ่งด้วยขึ้นบรรทัดใหม่และ . ! ? ; ไม่แบ่งด้วยช่องว่าง) ข้อความควรผ่าน normalizeText มาแล้ว
 */
export function findTermMatches(
  text: string,
  field: string,
  terms: ReadonlyArray<{ term: string }>,
  cues: readonly string[],
  maxGap: number,
): MatchedKeyword[] {
  if (!text || terms.length === 0) return [];
  const lower = lowerKeepLength(text);
  const lowerCues = cues.map((c) => c.toLowerCase()).filter((c) => c.length > 0);
  const maxCueLen = lowerCues.reduce((m, c) => Math.max(m, c.length), 0);
  const starts = sentenceStarts(lower);
  const out: MatchedKeyword[] = [];

  for (const { term } of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let from = 0;
    // เก็บผลต่อคำแยกตามแบบปฏิเสธ/ไม่ปฏิเสธ จำกัดอย่างละ MAX_PER_TERM — ข้อความที่ซ้ำคำเป็นแสนครั้งต้องไม่ทำให้ผลบวม
    // และการปฏิเสธ 100 ครั้งต้องไม่บังคำจริงที่อยู่ท้ายสุด (ทั้งสองแบบจึงเหลือเสมอ)
    let keptNegated = 0;
    let keptActive = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const windowStart = Math.max(sentenceStartOf(starts, idx), idx - maxGap - maxCueLen);
      const window = lower.slice(windowStart, idx);
      let negated = false;
      for (const cue of lowerCues) {
        const at = window.lastIndexOf(cue);
        if (at < 0) continue;
        const gap = window.length - (at + cue.length);
        if (gap <= maxGap && cueMatchesAt(window, at, cue)) {
          negated = true;
          break;
        }
      }
      if (negated ? keptNegated < MAX_PER_TERM : keptActive < MAX_PER_TERM) {
        out.push({ term, field, negated, start: idx, end: idx + needle.length });
        if (negated) keptNegated++;
        else keptActive++;
      }
      from = idx + needle.length;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
