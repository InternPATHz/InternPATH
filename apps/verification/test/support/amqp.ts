import * as amqp from 'amqplib';

/** ค่าเริ่มต้นตรงกับ .env.example (RabbitMQ จาก `pnpm infra:up`) */
export const brokerUrl = (): string => process.env.RABBITMQ_URL ?? 'amqp://internpath:change-me@127.0.0.1:5672';

/** e2e ลบคิว `verification.*` ทิ้ง จึงรันเฉพาะกับ broker ในเครื่อง ไม่แตะ broker ที่ใช้ร่วมกัน (เช่น CloudAMQP) */
function isLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

export async function brokerReachableOrSkip(ctx: Mocha.Context): Promise<void> {
  if (!isLocal(brokerUrl())) ctx.skip();
  try {
    const conn = await Promise.race([
      amqp.connect(brokerUrl()),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ]);
    await conn.close();
  } catch {
    ctx.skip();
  }
}

const QUEUES = ['JobSubmitted', 'JobStatusChanged', 'CompanyStatusChanged'].flatMap((t) => [
  `verification.${t}`,
  `verification.${t}.dlq`,
]);
const RETRY_QUEUES = [1, 2, 3].map((n) => `verification.retry.${n}`);

/** ลบคิวของ Service ทั้งหมด (คิวรับ Event + DLQ + retry) — เริ่มและจบ e2e ให้สะอาด */
export async function purgeVerificationQueues(): Promise<void> {
  const conn = await amqp.connect(brokerUrl());
  try {
    for (const q of [...QUEUES, ...RETRY_QUEUES]) {
      const ch = await conn.createChannel();
      ch.on('error', () => undefined);
      await ch.deleteQueue(q).catch(() => undefined);
      await ch.close().catch(() => undefined);
    }
  } finally {
    await conn.close().catch(() => undefined);
  }
}

export interface Collector {
  messages: any[];
  close(): Promise<void>;
}

/** คิวชั่วคราวที่รับ `verification.JobVerified` ทั้งหมด (จำลอง Job ที่รับผลตรวจ) */
export function collectJobVerified(): Promise<Collector> {
  return collectOutbound(['JobVerified']);
}

/** คิวชั่วคราวที่รับ Event ที่ Verification ส่ง (`verification.<type>`) ตามชนิดที่ระบุ (จำลอง Job/Notification ผู้รับ) */
export async function collectOutbound(types: string[]): Promise<Collector> {
  const conn = await amqp.connect(brokerUrl());
  const ch = await conn.createChannel();
  await ch.assertExchange('internpath.events', 'topic', { durable: true });
  const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
  for (const type of types) await ch.bindQueue(queue, 'internpath.events', `verification.${type}`);
  const messages: any[] = [];
  await ch.consume(queue, (m) => {
    if (!m) return;
    messages.push(JSON.parse(m.content.toString()));
    ch.ack(m);
  });
  return {
    messages,
    close: async () => {
      await conn.close().catch(() => undefined);
    },
  };
}

/** publish เหมือน Service อื่น (ผ่าน exchange `internpath.events` ด้วย routing key `<producer>.<type>`) */
export async function publishRaw(routingKey: string, body: Buffer, messageId?: string): Promise<void> {
  const conn = await amqp.connect(brokerUrl());
  try {
    const ch = await conn.createConfirmChannel();
    await new Promise<void>((resolve, reject) => {
      ch.publish('internpath.events', routingKey, body, { contentType: 'application/json', deliveryMode: 2, ...(messageId ? { messageId } : {}) }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  } finally {
    await conn.close().catch(() => undefined);
  }
}

export async function messageCount(queue: string): Promise<number> {
  const conn = await amqp.connect(brokerUrl());
  try {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    return (await ch.checkQueue(queue)).messageCount;
  } catch {
    return 0;
  } finally {
    await conn.close().catch(() => undefined);
  }
}
