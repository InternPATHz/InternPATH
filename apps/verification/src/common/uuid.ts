import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Correlation ID จาก header อาจไม่ใช่ UUID (libs/common ยอมรับ id ปลอดภัยรูปแบบอื่น) แต่คอลัมน์เป็น `uuid`
 * — ถ้าส่งค่าเดิมเข้า DB จะทำให้ Transaction ล้ม จึงแทนด้วย UUID ใหม่
 */
export function asUuid(value?: string): string {
  return value && UUID.test(value) ? value : randomUUID();
}
