/**
 * JSON ที่ Prisma รับเป็น Json (โครงสร้างเท่ากับ Prisma.InputJsonValue โดยไม่ import Prisma) —
 * ใช้ที่ขอบ tx เท่านั้น; OutboxEventInput.payload ยังรับ unknown และถูก cast ใน OutboxWriter
 */
export type OutboxJson = string | number | boolean | OutboxJsonObject | OutboxJsonArray;
export interface OutboxJsonObject {
  readonly [key: string]: OutboxJson | null | undefined;
}
export type OutboxJsonArray = ReadonlyArray<OutboxJson | null>;

/** ข้อมูลที่เขียนลง outbox_events (docs/data-schema.md §2.2) */
export interface OutboxCreateData {
  id: string;
  type: string;
  version: number;
  aggregateId: string;
  payload: OutboxJson;
  correlationId: string;
  /** เวลาสร้าง — เพิ่มขึ้นเข้มงวดต่อ OutboxWriter เพื่อให้ event ใน Transaction เดียวกันเรียงตามลำดับที่ add */
  createdAt: Date;
}

/**
 * ส่วนของ Prisma transaction client ที่ lib ต้องใช้ — กำหนดเชิงโครงสร้าง
 * เพื่อไม่ให้ libs/common ต้อง import Prisma ของ Service ใด
 */
export interface OutboxTx {
  outboxEvent: { create(args: { data: OutboxCreateData }): Promise<unknown> };
}

export interface OutboxEventInput {
  type: string;
  version?: number;
  aggregateId: string;
  correlationId: string;
  payload: unknown;
}

/** แถวของ outbox_events ที่ relay อ่านด้วย pg (ชื่อคอลัมน์ snake_case) */
export interface OutboxRow {
  id: string;
  type: string;
  version: number;
  aggregate_id: string;
  payload: unknown;
  correlation_id: string;
  created_at: Date;
}
