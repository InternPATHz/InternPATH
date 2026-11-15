import type { ReviewModerationResultPayload } from '@internpath/contracts';
import type { OutboxWriter } from '@internpath/common';
import type { Tx } from '../prisma/types';

/** ส่ง E10 `ReviewModerationResult` ผ่าน outbox ใน Transaction เดียวกับการเปลี่ยนข้อมูล (aggregate = รีวิว เพื่อรักษาลำดับต่อรีวิว) */
export function emitReviewModerationResult(
  outbox: OutboxWriter,
  tx: Tx,
  a: { payload: ReviewModerationResultPayload; correlationId: string },
): Promise<string> {
  return outbox.add(tx, {
    type: 'ReviewModerationResult',
    aggregateId: a.payload.review_id,
    correlationId: a.correlationId,
    payload: a.payload,
  });
}
