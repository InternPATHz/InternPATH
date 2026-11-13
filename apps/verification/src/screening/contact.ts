import type { ContactMatch } from './types';

export type { ContactMatch } from './types';

/**
 * ตรวจช่องทางติดต่อส่วนตัวที่แอบใส่ในข้อความ (README 5.1.5)
 * ทุก regex ใช้ตัวบวกแบบมีเพดาน (ไม่ซ้อนกัน) เพื่อไม่ให้ช้าแบบทวีคูณกับข้อความยาว
 */
const PATTERNS: Array<{ kind: ContactMatch['kind']; re: RegExp }> = [
  // มือถือไทย 0[689]x / +66 และเบอร์บ้าน 0[2-7]
  {
    kind: 'PHONE',
    re: /(?<![\d+])(?:\+66[\s-]?|0)(?:[689]\d[\s-]?\d{3}[\s-]?\d{4}|[2-7]\d?[\s-]?\d{3}[\s-]?\d{3,4})(?!\d)/g,
  },
  { kind: 'EMAIL', re: /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,5}/gi },
  // "line id: xxx", "line: xxx", "line @xxx", "ไลน์ xxx", "ไอดีไลน์ xxx" (ต้องมี id/เครื่องหมาย/@ กันคำว่า online)
  { kind: 'LINE', re: /(?<![a-z])line\s{0,3}(?:id\b\s{0,3}[:：]?|[:：])\s{0,3}@?[a-z0-9._-]{3,30}/gi },
  { kind: 'LINE', re: /(?<![a-z])line\s{0,3}@[a-z0-9._-]{3,30}/gi },
  { kind: 'LINE', re: /(?:ไอดีไลน์|ไลน์)\s{0,3}[:：]?\s{0,3}@?[a-z0-9._-]{3,30}/gi },
  { kind: 'LINE', re: /(?<![a-z0-9._%+-])@[a-z0-9._]{4,30}/gi },
  {
    kind: 'SOCIAL_LINK',
    re: /(?<![a-z0-9.-])(?:https?:\/\/)?(?:[a-z0-9-]{1,30}\.)?(?:line\.me|t\.me|wa\.me|m\.me|facebook\.com|fb\.com|instagram\.com|discord\.gg|tiktok\.com)(?:\/[^\s]{0,100})?/gi,
  },
];

export function detectContact(text: string): ContactMatch[] {
  const out: ContactMatch[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      out.push({ kind, start, end: start + m[0].length, matched: m[0] });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
