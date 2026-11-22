import type { JobObject } from '@internpath/contracts';

const baht = new Intl.NumberFormat('th-TH');

/**
 * ข้อความค่าตอบแทนของประกาศ (หน้าสาธารณะ: การ์ดค้นหา, หน้ารายละเอียดงาน)
 * `AMOUNT` ⇒ "จำนวนเงิน บาท" + คำอธิบายถ้ามี • `NONE` ⇒ คำอธิบายถ้ามี ไม่เช่นนั้น "ไม่มีค่าตอบแทน"
 * HR ไม่จำเป็นต้องกรอกคำอธิบาย (`allowance.text` อาจเป็น `''`) จึงห้ามแสดง `text` ตรง ๆ
 */
export function allowanceLabel(allowance: JobObject['allowance']): string {
  const text = allowance.text?.trim() ?? '';
  if (allowance.type === 'AMOUNT' && allowance.amount_thb != null) {
    return [`${baht.format(allowance.amount_thb)} บาท`, text].filter(Boolean).join(' · ');
  }
  return text || 'ไม่มีค่าตอบแทน';
}
