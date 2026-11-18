import type { CompanyStatusChangedPayload, EventEnvelope } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import type { Tx } from '../../prisma/types';
import {
  JOB_HIDDEN,
  freezeApplications,
  invalid,
  optionalUuid,
  requireOneOf,
  requireTimestamp,
  requireUuid,
  requireVersion,
  unfreezeApplications,
} from './handler-support';

const TYPE = 'CompanyStatusChanged';
type CompanyStatus = CompanyStatusChangedPayload['status'];
const COMPANY_STATUSES: readonly CompanyStatus[] = ['PENDING', 'NEED_MORE_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED'];

export type CompanyEventOutcome = 'applied' | 'stale';

/**
 * Consumer E05 `CompanyStatusChanged` (identity → lifecycle) — event-contract E05, data-schema §8.2.2, README §5.2.2
 *
 * - เทียบ `company_snapshots.entity_version` (Event เก่าไม่ทับใหม่ — เก่า/เท่ากัน ⇒ ข้ามทั้ง snapshot และผล)
 * - `SUSPENDED` ⇒ Freeze ใบที่ยังไม่ `IN_PROGRESS` (HR ตอบไม่ได้ ไม่ให้หมดเวลา) และใบ `IN_PROGRESS` ⇒
 *   `company_suspended_decision = PENDING` (อาจารย์ตัดสินฝึกต่อ/ยุติ — 1.6) • **ไม่คืนโควตา**
 * - `VERIFIED` ⇒ Unfreeze (ยกเว้นใบที่ประกาศยังถูกซ่อน) และล้างการรอตัดสิน `PENDING`/`CONTINUE` ของใบที่ยังฝึกอยู่
 *   (ถ้าถูกระงับอีกรอบจะถามอาจารย์ใหม่) • สถานะอื่น ⇒ อัปเดต snapshot อย่างเดียว
 * - **ยังไม่ส่งแจ้งอาจารย์/นักศึกษา** เมื่อบริษัทถูกระงับขณะฝึก — ยังไม่มี Event ที่ใช้ได้ (คำถามค้างถึง PM: TODO 1.11/1.12)
 */
@Injectable()
export class CompanyStatusChangedHandler {
  private readonly logger = new Logger(CompanyStatusChangedHandler.name);

  async handle(envelope: EventEnvelope<string, CompanyStatusChangedPayload>, tx: Tx): Promise<CompanyEventOutcome> {
    const p = envelope.payload ?? ({} as CompanyStatusChangedPayload);
    const companyId = requireUuid(TYPE, 'company_id', p.company_id);
    const status = requireOneOf(TYPE, 'status', p.status, COMPANY_STATUSES);
    const version = requireVersion(TYPE, p.entity_version);
    const changedAt = requireTimestamp(TYPE, 'changed_at', p.changed_at);
    optionalUuid(TYPE, 'owner_user_id', p.owner_user_id);
    const snapshot = p.snapshot;
    if (!snapshot || typeof snapshot.name !== 'string' || snapshot.name.trim() === '') invalid(TYPE, 'snapshot.name');
    if (typeof snapshot.university_partner !== 'boolean') invalid(TYPE, 'snapshot.university_partner');
    if (snapshot.logo_key !== undefined && typeof snapshot.logo_key !== 'string') invalid(TYPE, 'snapshot.logo_key');

    await tx.$executeRaw`
      INSERT INTO company_snapshots (company_id, name, status, entity_version, updated_at)
      VALUES (${companyId}::uuid, ${snapshot.name}, ${status}::company_status, 0, now())
      ON CONFLICT (company_id) DO NOTHING`;
    const [current] = await tx.$queryRaw<Array<{ entity_version: number }>>`
      SELECT entity_version FROM company_snapshots WHERE company_id = ${companyId}::uuid FOR UPDATE`;
    if (current.entity_version >= version) {
      this.logger.warn(`E05 ข้าม: entity_version ${version} ≤ snapshot ${current.entity_version} (company ${companyId})`);
      return 'stale';
    }
    await tx.companySnapshot.update({
      where: { companyId },
      data: {
        name: snapshot.name,
        logoKey: snapshot.logo_key ?? null,
        status,
        universityPartner: snapshot.university_partner,
        entityVersion: version,
      },
    });

    const scope = Prisma.sql`a.company_id = ${companyId}::uuid`;
    if (status === 'SUSPENDED') {
      await freezeApplications(tx, scope, changedAt);
      await tx.application.updateMany({
        where: { companyId, status: 'IN_PROGRESS', companySuspendedDecision: null },
        data: { companySuspendedDecision: 'PENDING', version: { increment: 1 } },
      });
    } else if (status === 'VERIFIED') {
      await unfreezeApplications(tx, scope, changedAt, JOB_HIDDEN);
      await tx.application.updateMany({
        where: { companyId, status: 'IN_PROGRESS', companySuspendedDecision: { in: ['PENDING', 'CONTINUE'] } },
        data: { companySuspendedDecision: null, version: { increment: 1 } },
      });
    }
    return 'applied';
  }
}
