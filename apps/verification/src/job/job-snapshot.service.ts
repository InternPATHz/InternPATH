import type { EventEnvelope, JobStatusChangedPayload } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/types';

@Injectable()
export class JobSnapshotService {
  /**
   * E03: เก็บสำเนาสถานะ/company_id ของประกาศ (ไว้ตอบว่ารายงานได้ไหมและหา company_id) เขียนทับเฉพาะเมื่อ entity_version
   * ใหม่กว่า (event-contract §3.4) — updateMany แบบมีเงื่อนไข + createMany skipDuplicates กัน Event สลับลำดับ/ขนาน
   */
  async apply(env: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    const data = { companyId: p.company_id, status: p.to_status, entityVersion: p.entity_version, updatedAt: new Date() };
    const update = () => tx.jobSnapshot.updateMany({ where: { jobId: p.job_id, entityVersion: { lt: p.entity_version } }, data });
    if ((await update()).count > 0) return;
    const created = await tx.jobSnapshot.createMany({ data: [{ jobId: p.job_id, ...data }], skipDuplicates: true });
    // แถวถูก Transaction อื่นสร้างแทรกระหว่างทาง ⇒ createMany ถูกข้าม ต้องลองอัปเดตแบบมีเงื่อนไขอีกครั้ง (กัน v2 หาย)
    if (created.count === 0) await update();
  }
}
