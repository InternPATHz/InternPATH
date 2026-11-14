/**
 * สร้างคิวของผู้รับ Event ทุกตัว (ตาม EVENT_CATALOG) ล่วงหน้า — รันครั้งเดียวหลังเปิด RabbitMQ และก่อนเปิด Service
 *   pnpm infra:topology          (ใช้ RABBITMQ_URL ถ้าตั้งไว้ มิฉะนั้นใช้ค่าของ RabbitMQ ใน docker-compose ในเครื่อง)
 * รันซ้ำได้ปลอดภัย (idempotent) และไม่พิมพ์ URL (มีรหัสผ่าน)
 */
import { EVENT_CATALOG } from '@internpath/contracts';
import * as amqp from 'amqplib';
import { provisionAllTopology } from '../src/messaging/provision';

const url = process.env.RABBITMQ_URL ?? 'amqp://internpath:change-me@127.0.0.1:5672';

async function main(): Promise<void> {
  const conn = await amqp.connect(url);
  try {
    const ch = await conn.createChannel();
    const { queues } = await provisionAllTopology(ch, EVENT_CATALOG);
    console.log(`สร้าง/ยืนยันคิวผู้รับแล้ว ${queues.length} คิว (พร้อม DLQ และ retry queue ของแต่ละ Service)`);
    await ch.close();
  } finally {
    await conn.close();
  }
}

main().catch((e: Error) => {
  console.error(`สร้าง topology ไม่สำเร็จ: ${e.message}`);
  process.exit(1);
});
