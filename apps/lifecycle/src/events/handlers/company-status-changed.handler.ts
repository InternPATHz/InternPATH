import { OutboxWriter } from '@internpath/common';
import type { CompanyStatusChangedPayload, EventEnvelope, ReminderDuePayload, ReminderType } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import type { Tx } from '../../prisma/types';
import { bangkokToday } from '../../state-machine/dates';
import { REMINDER_DUE, buildReminderDue } from '../producers/reminder-due';
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

/** E14 แจ้งอาจารย์/นักศึกษาว่าบริษัทถูกระงับขณะฝึก ต้องตัดสิน continue/terminate (PM ตัดสิน 2026-11-18) */
export const COMPANY_SUSPENDED_DECISION: ReminderType = 'COMPANY_SUSPENDED_DECISION';

type SuspendedApplication = { id: string; studentUserId: string; advisorUserId: string | null };

/**
 * Consumer E05 `CompanyStatusChanged` (identity → lifecycle) — event-contract E05, data-schema §8.2.2, README §5.2.2
 *
 * - เทียบ `company_snapshots.entity_version` (Event เก่าไม่ทับใหม่ — เก่า/เท่ากัน ⇒ ข้ามทั้ง snapshot และผล)
 * - `SUSPENDED` ⇒ Freeze ใบที่ยังไม่ `IN_PROGRESS` (HR ตอบไม่ได้ ไม่ให้หมดเวลา) และใบ `IN_PROGRESS` ⇒
 *   `company_suspended_decision = PENDING` (อาจารย์ตัดสินฝึกต่อ/ยุติ — 1.6) • **ไม่คืนโควตา**
 * - ใบที่เพิ่งถูกตั้ง `PENDING` ⇒ E14 `COMPANY_SUSPENDED_DECISION` ถึงอาจารย์ที่ดูแล + นักศึกษา (event-contract E14, data-schema §8)
 *   `due_date` = วันที่ (Asia/Bangkok) ที่รับ E05 และเขียน `reminder_log` ก่อน Outbox ใน `tx` เดียวกัน ⇒ รับซ้ำวันเดียวกันไม่แจ้งซ้ำ;
 *   ถูกระงับรอบใหม่ (คนละวัน หลังกลับ `VERIFIED`) ⇒ แจ้งใหม่ • ไม่ใช่ชนิดยกระดับ ⇒ Notification ไม่เติม Admin
 * - `VERIFIED` ⇒ Unfreeze (ยกเว้นใบที่ประกาศยังถูกซ่อน) และล้างการรอตัดสิน `PENDING`/`CONTINUE` ของใบที่ยังฝึกอยู่
 *   (ถ้าถูกระงับอีกรอบจะถามอาจารย์ใหม่) • สถานะอื่น ⇒ อัปเดต snapshot อย่างเดียว
 */
@Injectable()
export class CompanyStatusChangedHandler {
  private readonly logger = new Logger(CompanyStatusChangedHandler.name);

  constructor(private readonly outbox: OutboxWriter) {}

  async handle(
    envelope: EventEnvelope<string, CompanyStatusChangedPayload>,
    tx: Tx,
    now = new Date(),
  ): Promise<CompanyEventOutcome> {
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
      // ล็อกแถวไว้ก่อน (FOR UPDATE) ให้ชุดที่ตั้ง PENDING ตรงกับชุดที่แจ้ง แม้มี action ของอาจารย์มาพร้อมกัน
      const awaiting = await tx.$queryRaw<Array<{ id: string; student_user_id: string; advisor_user_id: string | null }>>`
        SELECT id, student_user_id, advisor_user_id FROM applications
        WHERE company_id = ${companyId}::uuid AND status = 'IN_PROGRESS'::application_status
          AND company_suspended_decision IS NULL
        ORDER BY id
        FOR UPDATE`;
      if (awaiting.length) {
        await tx.application.updateMany({
          where: { id: { in: awaiting.map((a) => a.id) } },
          data: { companySuspendedDecision: 'PENDING', version: { increment: 1 } },
        });
        const apps = awaiting.map((a) => ({ id: a.id, studentUserId: a.student_user_id, advisorUserId: a.advisor_user_id }));
        await this.notifySuspendedDecision(tx, apps, envelope.correlation_id, bangkokToday(now));
      }
    } else if (status === 'VERIFIED') {
      await unfreezeApplications(tx, scope, changedAt, JOB_HIDDEN);
      await tx.application.updateMany({
        where: { companyId, status: 'IN_PROGRESS', companySuspendedDecision: { in: ['PENDING', 'CONTINUE'] } },
        data: { companySuspendedDecision: null, version: { increment: 1 } },
      });
    }
    return 'applied';
  }

  /** เขียน `reminder_log` ก่อน (ชน unique ⇒ ข้าม) แล้ว Outbox E14 — อยู่ใน `tx` ของ Event จึงย้อนกลับพร้อมกันถ้าล้ม */
  private async notifySuspendedDecision(
    tx: Tx,
    apps: readonly SuspendedApplication[],
    correlationId: string,
    dueDate: Date,
  ): Promise<void> {
    for (const app of apps) {
      const { count } = await tx.reminderLog.createMany({
        data: [{ entityId: app.id, type: COMPANY_SUSPENDED_DECISION, dueDate }],
        skipDuplicates: true,
      });
      if (count !== 1) continue;
      const audience: ReminderDuePayload['audience'] = [
        ...(app.advisorUserId ? [{ user_id: app.advisorUserId, role: 'ADVISOR' }] : []),
        { user_id: app.studentUserId, role: 'STUDENT' },
      ];
      await this.outbox.add(tx, {
        type: REMINDER_DUE,
        aggregateId: app.id,
        correlationId,
        payload: buildReminderDue({
          reminderType: COMPANY_SUSPENDED_DECISION,
          applicationId: app.id,
          dueDate,
          audience,
          daysOverdue: 0,
        }),
      });
    }
  }
}
