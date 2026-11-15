import { foldForScan } from './normalize';
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
    // มือถือรับ 3-3-4, 2-4-4 และ 4-3-3 (ตัวคั่น ช่องว่าง/ขีด/จุด ได้ทีละตัว) — ไม่รับตัวคั่นทุกหลัก เพื่อไม่ให้จับวันที่+เวลา เช่น "06-11-2569 08.00"
    re: /(?<![\d+])(?:\+66[\s.-]?|0)(?:[689]\d[\s.-]?\d{3}[\s.-]?\d{4}|[689][\s.-]?\d{4}[\s.-]?\d{4}|[689]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}|[2-7]\d?[\s.-]?\d{3}[\s.-]?\d{3,4})(?!\d)/g,
  },
  { kind: 'EMAIL', re: /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,5}/gi },
  // อีเมลแบบเลี่ยง: "hr [at] example [dot] com", "hr(at)example.com"
  {
    kind: 'EMAIL',
    re: /[a-z0-9._%+-]{1,64}\s{0,3}[[(]\s{0,2}at\s{0,2}[\])]\s{0,3}[a-z0-9-]{1,63}(?:\s{0,3}(?:[[(]\s{0,2}dot\s{0,2}[\])]|\.)\s{0,3}[a-z0-9-]{1,63}){1,5}/gi,
  },
  // "line id: xxx", "line: xxx", "line @xxx", "ไลน์ xxx", "ไอดีไลน์ xxx" (ต้องมี id/เครื่องหมาย/@ กันคำว่า online)
  { kind: 'LINE', re: /(?<![a-z])line\s{0,3}(?:id\b\s{0,3}[:：]?|[:：])\s{0,3}@?[a-z0-9._-]{3,30}/gi },
  { kind: 'LINE', re: /(?<![a-z])line\s{0,3}@[a-z0-9._-]{3,30}/gi },
  { kind: 'LINE', re: /(?:ไอดีไลน์|ไลน์ไอดี|ไลน์)\s{0,3}[:：]?\s{0,3}@?[a-z0-9._-]{3,30}/gi },
  { kind: 'LINE', re: /(?<![a-z0-9._%+-])@[a-z0-9._]{4,30}/gi },
  {
    kind: 'SOCIAL_LINK',
    re: /(?<![a-z0-9.-])(?:https?:\/\/)?(?:[a-z0-9-]{1,30}\.)?(?:line\.me|t\.me|wa\.me|m\.me|facebook\.com|fb\.com|instagram\.com|discord\.gg|tiktok\.com)(?:\/[^\s]{0,100})?/gi,
  },
];

export function detectContact(text: string): ContactMatch[] {
  // สแกนบนข้อความที่ fold แล้ว (ความยาวเท่าเดิม) แต่ matched คืนข้อความเดิม เพื่อให้ไฮไลต์/เหตุผลตรงกับที่ผู้ใช้พิมพ์
  const folded = foldForScan(text);
  const out: ContactMatch[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of folded.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      out.push({ kind, start, end, matched: text.slice(start, end) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
