import { Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import type { Channel, ChannelModel, ConfirmChannel, Options } from 'amqplib';
import { assertBaseTopology } from './topology';

export interface BrokerConnectionOptions {
  url: string;
  /** backoff ตอนต่อใหม่ (ms) — ค่าเริ่มต้น 1000..30000 */
  reconnect?: { minMs: number; maxMs: number };
}

/**
 * การเชื่อมต่อ RabbitMQ เดียวต่อ Service: ต่อใหม่เองเมื่อหลุด และเรียก `onConnected`
 * ทุกครั้งที่ต่อสำเร็จ (รวมการต่อใหม่) เพื่อให้ผู้ใช้ประกาศ topology/subscribe ใหม่
 *
 * ทุกครั้งที่ต่อ จะประกาศ exchange พื้นฐาน (events/dlx/retry-return) ด้วย เพื่อให้ผู้ส่งไม่ต้องรอให้ผู้รับ
 * เป็นคนประกาศก่อน และ confirm channel ที่ broker ปิด (เช่น publish ไป exchange ที่ไม่มี) จะถูกสร้างใหม่เอง
 */
export class BrokerConnection {
  private readonly log = new Logger(BrokerConnection.name);
  private readonly reconnectOpts: { minMs: number; maxMs: number };
  private readonly callbacks: Array<() => Promise<void>> = [];
  private conn?: ChannelModel;
  private confirm?: ConfirmChannel;
  private closing = false;
  private attempt = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly opts: BrokerConnectionOptions) {
    this.reconnectOpts = opts.reconnect ?? { minMs: 1000, maxMs: 30000 };
  }

  /** ต่อครั้งแรก — ถ้าล้มเหลวจะ throw (ให้ผู้เรียกตัดสินใจ); หลังต่อสำเร็จแล้วหลุดจะต่อใหม่เอง */
  async connect(): Promise<void> {
    await this.open();
  }

  /** true เมื่อ connection และ confirm channel พร้อมใช้งานทั้งคู่ */
  isConnected(): boolean {
    return this.conn !== undefined && this.confirm !== undefined;
  }

  onConnected(cb: () => Promise<void>): void {
    this.callbacks.push(cb);
  }

  async createChannel(): Promise<Channel> {
    if (!this.conn) throw new Error('broker not connected');
    return this.conn.createChannel();
  }

  /** resolve หลัง broker confirm; throw ถ้าไม่ได้เชื่อมต่อ */
  async publish(
    exchange: string,
    routingKey: string,
    body: Buffer,
    options: Options.Publish,
  ): Promise<void> {
    const ch = this.confirm;
    if (!ch) throw new Error('broker not connected');
    await new Promise<void>((resolve, reject) => {
      ch.publish(exchange, routingKey, body, options, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    const conn = this.conn;
    this.conn = undefined;
    this.confirm = undefined;
    await conn?.close().catch(() => undefined);
  }

  private async open(): Promise<void> {
    const conn = await amqp.connect(this.opts.url);
    if (this.closing) {
      // close() ถูกเรียกระหว่างรอต่อ — ปิดทิ้ง ไม่ปล่อย connection ค้างที่ทำให้ process ไม่ยอมจบ
      await conn.close().catch(() => undefined);
      return;
    }
    // กัน unhandled 'error' — การหลุดจัดการผ่าน 'close'
    conn.on('error', (e: Error) => this.log.warn(`broker connection error: ${e.message}`));
    conn.on('close', () => this.handleClose(conn));
    let confirm: ConfirmChannel;
    try {
      confirm = await this.createConfirmChannel(conn);
    } catch (e) {
      await conn.close().catch(() => undefined);
      throw e;
    }
    if (this.closing) {
      await conn.close().catch(() => undefined);
      return;
    }
    this.conn = conn;
    this.confirm = confirm;
    this.attempt = 0;
    for (const cb of this.callbacks) {
      try {
        await cb();
      } catch (e) {
        this.log.error(`onConnected callback failed: ${(e as Error).message}`);
      }
    }
  }

  private async createConfirmChannel(conn: ChannelModel): Promise<ConfirmChannel> {
    const ch = await conn.createConfirmChannel();
    ch.on('error', (e: Error) => this.log.warn(`confirm channel error: ${e.message}`));
    ch.on('close', () => this.handleConfirmClosed(conn, ch));
    await assertBaseTopology(ch);
    return ch;
  }

  /** channel ถูกปิดแต่ connection ยังอยู่ (เช่น 404 จาก exchange ที่ไม่มี) — สร้างใหม่ ไม่ปล่อยให้ publish พังถาวร */
  private handleConfirmClosed(conn: ChannelModel, ch: ConfirmChannel): void {
    if (this.conn !== conn || this.confirm !== ch) return;
    this.confirm = undefined;
    if (this.closing) return;
    this.log.warn('confirm channel closed; recreating');
    void this.recreateConfirmChannel(conn);
  }

  private async recreateConfirmChannel(conn: ChannelModel): Promise<void> {
    try {
      const ch = await this.createConfirmChannel(conn);
      if (this.closing || this.conn !== conn) {
        await ch.close().catch(() => undefined);
        return;
      }
      this.confirm = ch;
    } catch (e) {
      this.log.warn(`recreating confirm channel failed: ${(e as Error).message}; reconnecting`);
      await conn.close().catch(() => undefined); // 'close' ของ connection นัดต่อใหม่ทั้งชุด
    }
  }

  private handleClose(conn: ChannelModel): void {
    if (this.conn !== conn) return; // การปิดของ connection เก่า/ที่เราปิดเอง
    this.conn = undefined;
    this.confirm = undefined;
    if (!this.closing) {
      this.log.warn('broker connection closed; reconnecting');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const { minMs, maxMs } = this.reconnectOpts;
    const delay = Math.min(maxMs, minMs * 2 ** this.attempt);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.open().catch((e: Error) => {
        this.log.warn(`reconnect failed: ${e.message}`);
        this.scheduleReconnect();
      });
    }, delay);
  }
}
