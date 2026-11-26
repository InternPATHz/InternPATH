import { randomBytes } from 'node:crypto';
import * as amqp from 'amqplib';

/** ค่าเริ่มต้นตรงกับ .env.example (RabbitMQ จาก `pnpm infra:up`) */
const baseBrokerUrl = (): string => process.env.RABBITMQ_URL ?? 'amqp://internpath:change-me@127.0.0.1:5672';

/**
 * e2e ใช้ vhost ส่วนตัวต่อไฟล์ (แบบเดียวกับเทสต์ของ Job) — เดิมใช้ vhost หลักร่วมกับ service ที่รันอยู่
 * ทำให้ Event ปลอม (บริษัท/ประกาศที่ไม่มีจริง) ไหลไปเข้าคิวของ Job/Lifecycle จริง และลบคิว verification.* ของ service จริงทิ้ง
 */
let sandbox: { url: string; name: string; admin: URL; auth: string } | undefined;
export const brokerUrl = (): string => sandbox?.url ?? baseBrokerUrl();

async function management(admin: URL, auth: string, route: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(new URL(route, admin), { method, signal: AbortSignal.timeout(5000),
    headers: { Authorization: auth, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** สร้าง vhost ทดสอบผ่าน management API (พอร์ต 15672 หรือ VERIFICATION_IT_RABBITMQ_ADMIN_URL) */
async function createSandbox(): Promise<boolean> {
  const broker = new URL(baseBrokerUrl());
  const admin = new URL(process.env.VERIFICATION_IT_RABBITMQ_ADMIN_URL ?? `http://${broker.hostname}:15672`);
  const user = decodeURIComponent(broker.username);
  const auth = `Basic ${Buffer.from(`${user}:${decodeURIComponent(broker.password)}`).toString('base64')}`;
  const name = `verification_it_${randomBytes(8).toString('hex')}`;
  try {
    if (!(await management(admin, auth, '/api/whoami')).ok) return false;
    if (!(await management(admin, auth, `/api/vhosts/${encodeURIComponent(name)}`, 'PUT', {})).ok) return false;
    sandbox = { url: '', name, admin, auth };
    const granted = await management(admin, auth, `/api/permissions/${encodeURIComponent(name)}/${encodeURIComponent(user)}`, 'PUT',
      { configure: '.*', write: '.*', read: '.*' });
    if (!granted.ok) { await dropBrokerSandbox(); return false; }
    broker.pathname = `/${name}`;
    sandbox.url = broker.toString();
    return true;
  } catch {
    await dropBrokerSandbox();
    return false;
  }
}

/** ลบ vhost ทดสอบ (เรียกใน after ของแต่ละไฟล์ e2e) — ลบเฉพาะชื่อที่สร้างโดยเทสต์ */
export async function dropBrokerSandbox(): Promise<void> {
  const current = sandbox;
  sandbox = undefined;
  if (!current || !/^verification_it_[0-9a-f]{16}$/.test(current.name)) return;
  await management(current.admin, current.auth, `/api/vhosts/${encodeURIComponent(current.name)}`, 'DELETE').catch(() => undefined);
}

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
  if (!isLocal(baseBrokerUrl())) ctx.skip();
  if (!sandbox && !(await createSandbox())) {
    console.warn('Verification e2e pending: ต้องใช้ RabbitMQ management API (15672) เพื่อสร้าง vhost ทดสอบแยก');
    ctx.skip();
  }
  try {
    const conn = await Promise.race([
      amqp.connect(brokerUrl()),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ]);
    await conn.close();
  } catch {
    await dropBrokerSandbox();
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
