import { Client } from 'pg';
import type { RelayDb } from './outbox-relay';

/** ส่วนของ pg.Client ที่ PgRelayDb ใช้ (แยกไว้เพื่อทดสอบด้วย fake) */
export interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (err?: Error) => void): unknown;
}

const defaultFactory = (url: string): PgClientLike =>
  new Client({ connectionString: url, connectionTimeoutMillis: 5000 }) as unknown as PgClientLike;

/**
 * RelayDb บน pg.Client เดียว (relay ต้องใช้ connection เดียวต่อ Transaction/advisory lock)
 * ต่อใหม่เองในการเรียกครั้งถัดไปเมื่อ connection หลุด (เช่น Postgres restart)
 */
export class PgRelayDb implements RelayDb {
  private client?: PgClientLike;

  constructor(
    private readonly url: string,
    private readonly factory: (url: string) => PgClientLike = defaultFactory,
  ) {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
    const c = await this.ensure();
    return c.query(sql, params);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.end().catch(() => undefined);
  }

  private async ensure(): Promise<PgClientLike> {
    if (this.client) return this.client;
    const c = this.factory(this.url);
    // กัน unhandled 'error' และทิ้ง client ที่หลุดเพื่อให้ครั้งถัดไปต่อใหม่
    c.on('error', () => this.drop(c));
    c.on('end', () => this.drop(c));
    try {
      await c.connect();
    } catch (e) {
      await c.end().catch(() => undefined);
      throw e;
    }
    this.client = c;
    return c;
  }

  private drop(c: PgClientLike): void {
    if (this.client === c) this.client = undefined;
    c.end().catch(() => undefined);
  }
}
