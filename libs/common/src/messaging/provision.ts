import type { EventCatalogEntry } from '@internpath/contracts';
import type { Channel } from 'amqplib';
import { DEFAULT_RETRY_DELAYS_MS, assertBaseTopology, assertConsumerTopology } from './topology';

/**
 * ประกาศ exchange พื้นฐานและ **คิวของผู้รับทุกตัวตามแคตตาล็อก** (คิว + DLQ + binding + retry queue ร่วมต่อ Service)
 * ล่วงหน้า ก่อนเปิด Service ใดๆ — ไม่เช่นนั้น Event ที่ผู้ส่งเผยแพร่ก่อนที่ผู้รับจะเคยเริ่มทำงานจะไม่มีคิวรับและหายไป
 * ปลอดภัยที่จะรันซ้ำ (idempotent: ใช้ assert เหมือนที่ EventConsumer ใช้ตอน subscribe)
 */
export async function provisionAllTopology(
  ch: Channel,
  catalog: readonly EventCatalogEntry[],
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<{ queues: string[] }> {
  await assertBaseTopology(ch);
  const queues: string[] = [];
  for (const event of catalog) {
    for (const service of event.consumers) {
      const { queue } = await assertConsumerTopology(ch, { service, producer: event.producer, type: event.type, retryDelaysMs });
      queues.push(queue);
    }
  }
  return { queues };
}
