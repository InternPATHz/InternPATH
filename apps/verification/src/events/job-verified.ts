import type { JobVerifiedPayload } from '@internpath/contracts';
import type { OutboxWriter } from '@internpath/common';
import type { Tx } from '../prisma/types';

/** ส่ง E02 `JobVerified` ผ่าน outbox ใน Transaction เดียวกับการเปลี่ยนข้อมูล (aggregate = ประกาศ เพื่อรักษาลำดับต่อประกาศ) */
export function emitJobVerified(
  outbox: OutboxWriter,
  tx: Tx,
  a: { payload: JobVerifiedPayload; correlationId: string },
): Promise<string> {
  return outbox.add(tx, {
    type: 'JobVerified',
    aggregateId: a.payload.job_id,
    correlationId: a.correlationId,
    payload: a.payload,
  });
}
