// ต้องตรงกับ docs/event-contract.md §1

export type ServiceName =
  | 'identity'
  | 'job'
  | 'verification'
  | 'lifecycle'
  | 'notification';

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  /** UUID v4 — ใช้ทำ Idempotency ฝั่ง Consumer */
  event_id: string;
  type: TType;
  /** เวอร์ชันของ Schema Payload (integer เริ่มที่ 1) */
  version: number;
  /** ISO-8601 UTC */
  occurred_at: string;
  correlation_id: string;
  producer: ServiceName;
  payload: TPayload;
}

export const EVENTS_EXCHANGE = 'internpath.events';
export const DLX_EXCHANGE = 'internpath.dlx';

/** routing key = `<producer>.<EventType>` */
export const routingKey = (producer: ServiceName, type: string): string =>
  `${producer}.${type}`;
