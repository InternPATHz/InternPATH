import type { CompanyFlagChangedPayload } from '@internpath/contracts';
import type { OutboxWriter } from '@internpath/common';
import type { Tx } from '../prisma/types';

/** ส่ง E18 `CompanyFlagChanged` ผ่าน outbox ใน Transaction เดียวกับการเปลี่ยนธง (aggregate = บริษัท เพื่อรักษาลำดับ) */
export function emitCompanyFlagChanged(
  outbox: OutboxWriter,
  tx: Tx,
  a: { payload: CompanyFlagChangedPayload; correlationId: string },
): Promise<string> {
  return outbox.add(tx, {
    type: 'CompanyFlagChanged',
    aggregateId: a.payload.company_id,
    correlationId: a.correlationId,
    payload: a.payload,
  });
}
