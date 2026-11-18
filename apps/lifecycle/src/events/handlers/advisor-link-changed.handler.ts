import type { AdvisorLinkChangedPayload, ApplicationStatus, EventEnvelope } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../../prisma/types';
import { invalid, optionalUuid, requireOneOf, requireTimestamp, requireUuid, requireVersion } from './handler-support';

const TYPE = 'AdvisorLinkChanged';
type LinkStatus = AdvisorLinkChangedPayload['link_status'];
const LINK_STATUSES: readonly LinkStatus[] = ['ADVISOR_LINK_PENDING', 'LINKED', 'UNLINKED'];
const CHANGED_BY: readonly AdvisorLinkChangedPayload['changed_by'][] = ['STUDENT', 'ADVISOR', 'ADMIN'];

/**
 * ใบที่ "สิ้นสุดแล้ว" ไม่ย้ายตามอาจารย์ใหม่ — ส่วนใบ `TERMINATED`/`NO_EVALUATION`/`EVALUATED_*` ที่ยังไม่บันทึก
 * `academic_result` ต้องย้าย (อาจารย์คนใหม่เป็นผู้บันทึกผลวิชา)
 */
const ENDED_STATUSES: readonly ApplicationStatus[] = [
  'HR_REJECTED',
  'STUDENT_DECLINED',
  'ADVISOR_REJECTED',
  'OFFER_RESCINDED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED',
  'COMPLETED',
];

export type AdvisorLinkOutcome = 'applied' | 'stale';

/**
 * Consumer E07 `AdvisorLinkChanged` (identity → lifecycle) — event-contract E07, README §5.6, data-schema §8.4
 *
 * - เทียบ `student_advisor_links.entity_version` (เก่า/เท่ากัน ⇒ ข้าม)
 * - `LINKED` ⇒ ลิงก์ = อาจารย์ใหม่ และ **ย้าย `advisor_user_id` ของใบที่ยังไม่สิ้นสุด** (+ รายงานปัญหาที่ยังไม่ปิดของใบนั้น)
 *   — คิวอาจารย์/ความเป็นเจ้าของ (1.6) ใช้ `applications.advisor_user_id` จึงย้ายตามทันที
 * - `ADVISOR_LINK_PENDING` ⇒ บันทึกสถานะรอยืนยัน **ใบสมัครค้างอยู่กับอาจารย์เดิม** จนกว่าอาจารย์ใหม่ยืนยัน (§8.4)
 * - `UNLINKED` ⇒ ล้างอาจารย์ของลิงก์ (`NONE`) — ใบสมัครเดิมไม่เปลี่ยน
 */
@Injectable()
export class AdvisorLinkChangedHandler {
  private readonly logger = new Logger(AdvisorLinkChangedHandler.name);

  async handle(envelope: EventEnvelope<string, AdvisorLinkChangedPayload>, tx: Tx): Promise<AdvisorLinkOutcome> {
    const p = envelope.payload ?? ({} as AdvisorLinkChangedPayload);
    const studentUserId = requireUuid(TYPE, 'student_user_id', p.student_user_id);
    const linkStatus = requireOneOf(TYPE, 'link_status', p.link_status, LINK_STATUSES);
    requireOneOf(TYPE, 'changed_by', p.changed_by, CHANGED_BY);
    const version = requireVersion(TYPE, p.entity_version);
    requireTimestamp(TYPE, 'changed_at', p.changed_at);
    const oldAdvisor = optionalUuid(TYPE, 'old_advisor_id', p.old_advisor_id);
    const newAdvisor = optionalUuid(TYPE, 'new_advisor_id', p.new_advisor_id);
    if (linkStatus === 'LINKED' && !newAdvisor) invalid(TYPE, 'new_advisor_id');

    await tx.$executeRaw`
      INSERT INTO student_advisor_links (student_user_id, link_status, entity_version, updated_at)
      VALUES (${studentUserId}::uuid, 'NONE'::advisor_link_status, 0, now())
      ON CONFLICT (student_user_id) DO NOTHING`;
    const [current] = await tx.$queryRaw<Array<{ entity_version: number; advisor_user_id: string | null }>>`
      SELECT entity_version, advisor_user_id FROM student_advisor_links
      WHERE student_user_id = ${studentUserId}::uuid FOR UPDATE`;
    if (current.entity_version >= version) {
      this.logger.warn(`E07 ข้าม: entity_version ${version} ≤ link ${current.entity_version} (student ${studentUserId})`);
      return 'stale';
    }

    if (linkStatus === 'LINKED') {
      await tx.studentAdvisorLink.update({
        where: { studentUserId },
        data: { advisorUserId: newAdvisor, linkStatus: 'LINKED', entityVersion: version },
      });
      const moving = await tx.application.findMany({
        where: {
          studentUserId,
          status: { notIn: [...ENDED_STATUSES] },
          academicResult: null,
          OR: [{ advisorUserId: null }, { advisorUserId: { not: newAdvisor } }],
        },
        select: { id: true },
      });
      const ids = moving.map((a) => a.id);
      if (ids.length) {
        await tx.application.updateMany({
          where: { id: { in: ids } },
          data: { advisorUserId: newAdvisor, version: { increment: 1 } },
        });
        await tx.problemReport.updateMany({
          where: { applicationId: { in: ids }, status: { not: 'RESOLVED' } },
          data: { advisorUserId: newAdvisor },
        });
      }
    } else if (linkStatus === 'ADVISOR_LINK_PENDING') {
      await tx.studentAdvisorLink.update({
        where: { studentUserId },
        // อาจารย์ปัจจุบันยังเป็นคนเดิม (ไม่มีลิงก์มาก่อน ⇒ old_advisor_id ถ้ามี)
        data: { linkStatus: 'ADVISOR_LINK_PENDING', advisorUserId: current.advisor_user_id ?? oldAdvisor ?? null, entityVersion: version },
      });
    } else {
      await tx.studentAdvisorLink.update({
        where: { studentUserId },
        data: { linkStatus: 'NONE', advisorUserId: null, entityVersion: version },
      });
    }
    return 'applied';
  }
}
