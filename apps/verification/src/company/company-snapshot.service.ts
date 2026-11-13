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
    const update = () =>
      tx.companySnapshot.updateMany({ where: { companyId: p.company_id, entityVersion: { lt: p.entity_version } }, data });
    if ((await update()).count > 0) return;
    const created = await tx.companySnapshot.createMany({ data: [{ companyId: p.company_id, ...data }], skipDuplicates: true });
    // แถวถูก Transaction อื่นสร้างแทรกระหว่างทาง (เช่น v1 ชนะ v2) ⇒ createMany ถูกข้าม ต้องลองอัปเดตแบบมีเงื่อนไขอีกครั้ง
    // ไม่เช่นนั้น v2 จะหายไป (updateMany รอบแรกเห็นว่าไม่มีแถว แต่ createMany เห็นว่ามีแล้ว)
    if (created.count === 0) await update();
  }
}
