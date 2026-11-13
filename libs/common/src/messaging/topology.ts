import { DLX_EXCHANGE, EVENTS_EXCHANGE, routingKey, type ServiceName } from '@internpath/contracts';
import type { Channel } from 'amqplib';

/**
 * Headers exchange ที่ retry queue ส่งข้อความกลับ (หลัง TTL หมด) ไปยังคิวต้นทาง
 * โดยจับคู่ header `origin-queue` กับคิวผู้รับแต่ละตัว (docs/event-contract.md §3.3)
 */
export const RETRY_RETURN_EXCHANGE = 'internpath.retry-return';

/** หน่วงก่อนลองใหม่ครั้งที่ 1/2/3 (event-contract §3.3) */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5000, 30000, 120000];

/** ห้ามขึ้นต้นด้วย 'x-': headers exchange ของ RabbitMQ ไม่นำ header 'x-*' มาจับคู่ binding (พบจากเทสต์จริง) */
export const ORIGIN_QUEUE_HEADER = 'origin-queue';
export const RETRY_COUNT_HEADER = 'x-retry-count';

export const consumerQueueName = (consumer: string, type: string): string => `${consumer}.${type}`;
export const dlqName = (queue: string): string => `${queue}.dlq`;
/** attempt เริ่มที่ 1; retry queue ร่วมต่อ Service (ไม่แยกต่อ EventType) */
export const retryQueueName = (service: string, attempt: number): string =>
  `${service}.retry.${attempt}`;

export async function assertBaseTopology(ch: Channel): Promise<void> {
  await ch.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await ch.assertExchange(DLX_EXCHANGE, 'direct', { durable: true });
  await ch.assertExchange(RETRY_RETURN_EXCHANGE, 'headers', { durable: true });
}

export interface ConsumerTopologyArgs {
  service: string;
  producer: ServiceName;
  type: string;
  retryDelaysMs: readonly number[];
}

/** ประกาศคิวผู้รับ + DLQ + retry queue ร่วมของ Service (idempotent) */
export async function assertConsumerTopology(
  ch: Channel,
  a: ConsumerTopologyArgs,
): Promise<{ queue: string; dlq: string }> {
  const queue = consumerQueueName(a.service, a.type);
  const dlq = dlqName(queue);

  await ch.assertQueue(dlq, { durable: true });
  await ch.bindQueue(dlq, DLX_EXCHANGE, queue);

  await ch.assertQueue(queue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DLX_EXCHANGE, 'x-dead-letter-routing-key': queue },
  });
  await ch.bindQueue(queue, EVENTS_EXCHANGE, routingKey(a.producer, a.type));
  await ch.bindQueue(queue, RETRY_RETURN_EXCHANGE, '', {
    'x-match': 'all',
    [ORIGIN_QUEUE_HEADER]: queue,
  });

  for (let i = 0; i < a.retryDelaysMs.length; i++) {
    await ch.assertQueue(retryQueueName(a.service, i + 1), {
      durable: true,
      arguments: {
        'x-message-ttl': a.retryDelaysMs[i],
        // ไม่ตั้ง dead-letter routing key: headers exchange จับคู่จาก header ไม่ใช่ routing key
        'x-dead-letter-exchange': RETRY_RETURN_EXCHANGE,
      },
    });
  }
  return { queue, dlq };
}
