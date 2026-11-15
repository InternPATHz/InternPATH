import type { QueueHighlight } from '@internpath/contracts';

/**
 * แสดงข้อความพร้อมไฮไลต์ตามออฟเซ็ตที่ Verification ส่งมา (อ้างอิงข้อความที่ผ่าน normalize แล้ว ซึ่งเป็นข้อความเดียวกับที่ API คืนใน `content`)
 * - คำต้องห้ามเป็นพื้นแดง; `negated` (อยู่ในประโยคปฏิเสธ) เป็นพื้นเหลืองและขีดเส้นประ
 * - ออฟเซ็ตผิดช่วง/ซ้อนกันจะถูกข้ามแทนที่จะทำให้หน้าพัง
 */
export function HighlightedText({ text, highlights }: { text: string; highlights: QueueHighlight[] }) {
  const sorted = [...highlights]
    .filter((h) => Number.isInteger(h.start) && Number.isInteger(h.end) && h.start >= 0 && h.end > h.start && h.end <= text.length)
    .sort((a, b) => a.start - b.start);

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const h of sorted) {
    if (h.start < cursor) continue; // ซ้อนกับช่วงก่อนหน้า
    if (h.start > cursor) parts.push(text.slice(cursor, h.start));
    parts.push(
      <mark
        key={`${h.start}-${h.end}`}
        title={h.negated ? `${h.keyword} (อยู่ในประโยคปฏิเสธ)` : h.keyword}
        className={h.negated
          ? 'rounded bg-warning-soft px-0.5 text-warning-text underline decoration-dashed'
          : 'rounded bg-danger-soft px-0.5 font-medium text-danger-text'}
      >
        {text.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <p className="whitespace-pre-wrap break-words text-sm leading-thai">{parts}</p>;
}
