import type { EventEnvelope, ServiceName } from '@internpath/contracts';
import type { OutboxRow } from './outbox.types';

/** สร้าง Envelope ตาม docs/event-contract.md §1 จากแถว outbox */
export function buildEnvelope(row: OutboxRow, producer: ServiceName): EventEnvelope {
  return {
    event_id: row.id,
    type: row.type,
    version: row.version,
    occurred_at: row.created_at.toISOString(),
    correlation_id: row.correlation_id,
    producer,
    payload: row.payload,
  };
}
