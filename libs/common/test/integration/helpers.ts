import { randomBytes } from 'node:crypto';
import * as amqp from 'amqplib';

/** ค่าเริ่มต้นตรงกับ .env.example (RabbitMQ/Postgres จาก `pnpm infra:up`) */
export const brokerUrl = (): string =>
  process.env.RABBITMQ_URL ?? 'amqp://internpath:change-me@127.0.0.1:5672';
export const pgUrl = (): string =>
  process.env.MESSAGING_IT_DATABASE_URL ?? 'postgresql://internpath:change-me@127.0.0.1:5432/internpath';

export async function brokerReachable(url = brokerUrl()): Promise<boolean> {
  try {
    const conn = await Promise.race([
      amqp.connect(url),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ]);
    await conn.close();
    return true;
  } catch {
    return false;
  }
}

/** เรียกใน `before(function () {...})` — ข้ามทั้ง suite เมื่อต่อ RabbitMQ ไม่ได้ */
export async function brokerReachableOrSkip(ctx: Mocha.Context): Promise<void> {
  if (!(await brokerReachable())) ctx.skip();
}

/** ชื่อ Service สุ่มต่อการรัน กันชนกับคิวของจริง/การรันอื่น */
export const uniqueService = (): string => `it${randomBytes(4).toString('hex')}`;

/** เก็บ queue ที่เทสต์สร้างแล้วลบทิ้งตอนจบ (กันกิน queue quota ของ CloudAMQP) */
export class QueueCleanup {
  private readonly queues = new Set<string>();

  add(...names: string[]): void {
    names.forEach((n) => this.queues.add(n));
  }

  async run(): Promise<void> {
    if (this.queues.size === 0) return;
    const conn = await amqp.connect(brokerUrl());
    try {
      for (const q of this.queues) {
        // channel ที่ error (เช่นคิวไม่มี) จะถูกปิด — ใช้ channel ใหม่ต่อคิว
        const c = await conn.createChannel();
        c.on('error', () => undefined);
        await c.deleteQueue(q).catch(() => undefined);
        await c.close().catch(() => undefined);
      }
    } finally {
      await conn.close().catch(() => undefined);
      this.queues.clear();
    }
  }
}

/** poll ดึงข้อความจากคิวด้วย channel.get จนกว่าจะได้หรือหมดเวลา */
export async function getWithin(
  ch: amqp.Channel,
  queue: string,
  ms: number,
): Promise<amqp.GetMessage | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = await ch.get(queue, { noAck: false });
    if (m) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/** เรียกใน `before(function () {...})` — ข้ามทั้ง suite เมื่อต่อ Postgres ไม่ได้ */
export async function pgReachableOrSkip(ctx: Mocha.Context): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: pgUrl(), connectionTimeoutMillis: 2000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch {
    ctx.skip();
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** รอจนเงื่อนไขเป็นจริงหรือหมดเวลา (throw พร้อม label เมื่อหมดเวลา) */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  label: string,
  ms = 8000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for: ${label}`);
}
