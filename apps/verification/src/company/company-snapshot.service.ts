import type { CompanyStatusChangedPayload, EventEnvelope } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/types';

@Injectable()
export class CompanySnapshotService {
  /**
   * E05: เก็บสำเนาชื่อ/สถานะบริษัท (ไว้แสดงในคิว Admin) เขียนทับเฉพาะเมื่อ entity_version ใหม่กว่า
   * (docs/event-contract.md §3.4) — updateMany แบบมีเงื่อนไข + createMany skipDuplicates กัน Event สลับลำดับ/ขนาน
   */
  async handleCompanyStatusChanged(env: EventEnvelope<'CompanyStatusChanged', CompanyStatusChangedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    const data = { name: p.snapshot.name, status: p.status, entityVersion: p.entity_version, updatedAt: new Date() };
    const { count } = await tx.companySnapshot.updateMany({
      where: { companyId: p.company_id, entityVersion: { lt: p.entity_version } },
      data,
    });
    if (count === 0) {
      await tx.companySnapshot.createMany({ data: [{ companyId: p.company_id, ...data }], skipDuplicates: true });
    }
  }
}
