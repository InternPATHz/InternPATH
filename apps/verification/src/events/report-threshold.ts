import type { ReportThresholdReachedPayload } from '@internpath/contracts';
import type { OutboxWriter } from '@internpath/common';
import type { Tx } from '../prisma/types';

/** ส่ง E04 `ReportThresholdReached` ผ่าน outbox ใน Transaction เดียวกับตัวนับ (aggregate = ประกาศ เพื่อรักษาลำดับต่อประกาศ) */
export function emitReportThresholdReached(
  outbox: OutboxWriter,
  tx: Tx,
  a: { payload: ReportThresholdReachedPayload; correlationId: string },
): Promise<string> {
  return outbox.add(tx, {
    type: 'ReportThresholdReached',
    aggregateId: a.payload.job_id,
    correlationId: a.correlationId,
    payload: a.payload,
  });
}
