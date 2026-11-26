import { EventConsumer, InvalidMessageError } from '@internpath/common';
import {
  EVENT_CATALOG,
  type AdvisorLinkChangedPayload,
  type ApplicationStatusChangedPayload,
  type CertificateIssuedPayload,
  type CertificateRevokedPayload,
  type CompanyFlagChangedPayload,
  type CompanyStatusChangedPayload,
  type ConductReportCreatedPayload,
  type EventEnvelope,
  type JobStatusChangedPayload,
  type ProblemReportCreatedPayload,
  type ReminderDuePayload,
  type ReminderType,
  type ReportThresholdReachedPayload,
  type ReviewModerationResultPayload,
  type ReviewPublishedPayload,
  type UserDeletionRequestedPayload,
  type UserSuspendedPayload,
} from '@internpath/contracts';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../../generated/client';
import { IdentityClient } from '../../internal/identity-client';
import { recipientKey } from '../../recipient-key';
import { applicationChannels } from './application-recipients';

type Tx = Prisma.TransactionClient;
interface Recipient {
  id: string;
  email?: boolean;
  link?: string;
}
interface Notice {
  title: string;
  body: string;
  recipients: Recipient[];
}

const jobStatusMessages: Partial<Record<JobStatusChangedPayload['to_status'], string>> = {
  PUBLISHED: 'ประกาศเผยแพร่แล้ว',
  PENDING_REVIEW: 'ประกาศอยู่ระหว่างรอผู้ดูแลระบบตรวจ',
  ADMIN_REJECTED: 'ผู้ดูแลระบบปฏิเสธประกาศ',
  SUSPENDED: 'ประกาศถูกระงับชั่วคราว',
  REMOVED: 'ประกาศถูกนำออก',
};

const companyStatusMessages: Partial<Record<CompanyStatusChangedPayload['status'], string>> = {
  VERIFIED: 'บริษัทผ่านการยืนยันแล้ว',
  NEED_MORE_INFO: 'ผู้ดูแลระบบขอข้อมูลบริษัทเพิ่มเติม',
  REJECTED: 'คำขอยืนยันบริษัทถูกปฏิเสธ',
  SUSPENDED: 'บัญชีบริษัทถูกระงับ',
};

const applicationStatusMessages: Partial<
  Record<ApplicationStatusChangedPayload['to_status'], string>
> = {
  PENDING: 'มีใบสมัครใหม่',
  HR_ACCEPTED: 'บริษัทส่งข้อเสนอฝึกงานแล้ว',
  ADVISOR_PENDING: 'ใบสมัครรออาจารย์อนุมัติ',
  ADVISOR_APPROVED: 'อาจารย์อนุมัติการฝึกงานแล้ว',
  IN_PROGRESS: 'บริษัทยืนยันการเริ่มฝึกงานแล้ว',
  EVALUATED_PASS: 'ผลการประเมินการฝึกงานผ่าน',
  EVALUATED_FAIL: 'ผลการประเมินการฝึกงานไม่ผ่าน',
  FAIL_DISPUTED: 'มีคำขอทบทวนผลการประเมิน',
  REEVALUATION_REQUESTED: 'มีคำขอประเมินผลการฝึกงานใหม่',
  COMPLETED: 'สิ้นสุดการฝึกงานแล้ว',
  NO_EVALUATION: 'สิ้นสุดการฝึกงานโดยไม่มีผลประเมิน',
  TERMINATED: 'ยุติการฝึกงานแล้ว',
  HR_REJECTED: 'บริษัทปฏิเสธใบสมัคร',
  ADVISOR_REJECTED: 'อาจารย์ปฏิเสธใบสมัคร',
  OFFER_RESCINDED: 'บริษัทถอนข้อเสนอฝึกงาน',
  CANCELLED: 'ใบสมัครถูกยกเลิก',
  STUDENT_DECLINED: 'นักศึกษาปฏิเสธข้อเสนอ',
  WITHDRAWN: 'นักศึกษาถอนใบสมัคร',
  EXPIRED: 'ใบสมัครหมดเวลา',
};

/**
 * หน้าของอาจารย์ที่ต้องเปิดตามสถานะใหม่ของใบสมัคร (หน้าอาจารย์ไม่มีหน้ารายละเอียดรายใบ จึงลิงก์ไปหน้ารายการ)
 * รออนุมัติ ⇒ อนุมัติฝึกงาน • ผลประเมิน/โต้แย้ง/สิ้นสุด ⇒ ประเมินผล • อื่น ๆ ⇒ นักศึกษาของฉัน
 */
function advisorLink(status: ApplicationStatusChangedPayload['to_status']): string {
  if (status === 'ADVISOR_PENDING') return '/advisor/approvals';
  if (
    [
      'EVALUATED_PASS',
      'EVALUATED_FAIL',
      'FAIL_DISPUTED',
      'COMPLETED',
      'NO_EVALUATION',
      'TERMINATED',
    ].includes(status)
  )
    return '/advisor/evaluations';
  return '/advisor/students';
}

/** หน้าของอาจารย์ตามชนิดการเตือน (README UAT-18/21/22/27/34) — เดิมอาจารย์ได้แจ้งเตือนแบบไม่มีลิงก์ */
function advisorReminderLink(type: ReminderType): string {
  if (type === 'ADVISOR_APPROVE_D3' || type === 'ADVISOR_APPROVE_ESCALATE_ADMIN_D7')
    return '/advisor/approvals';
  if (
    [
      'EVALUATE_ESCALATE_D14',
      'ISSUE_CERT_ESCALATE_D14',
      'ADVISOR_DISPUTE_D3',
      'DISPUTE_ESCALATE_D7',
    ].includes(type)
  )
    return '/advisor/evaluations';
  return '/advisor/students';
}

const escalations = new Set<ReminderType>([
  'ADVISOR_APPROVE_ESCALATE_ADMIN_D7',
  'START_CONFIRM_ESCALATE_D7',
  'EVALUATE_ESCALATE_D14',
  'ISSUE_CERT_ESCALATE_D14',
  'DISPUTE_ESCALATE_D7',
]);

const reminderMessages: Record<ReminderType, string> = {
  HR_RESPOND_PENDING_D3: 'ใบสมัครรอบริษัทพิจารณา',
  HR_RESPOND_PENDING_D7: 'ใบสมัครรอบริษัทพิจารณาเกินกำหนด',
  STUDENT_CONFIRM_D3: 'ข้อเสนอฝึกงานรอนักศึกษาตอบรับ',
  ADVISOR_APPROVE_D3: 'ใบสมัครรออาจารย์อนุมัติ',
  ADVISOR_APPROVE_ESCALATE_ADMIN_D7: 'ใบสมัครรออาจารย์อนุมัติเกินกำหนด',
  HR_START_CONFIRM_ON_START: 'ถึงวันเริ่มฝึกงาน กรุณายืนยันการเริ่มฝึกงาน',
  HR_START_CONFIRM_D3: 'ยังไม่ได้ยืนยันการเริ่มฝึกงาน',
  START_CONFIRM_ESCALATE_D7: 'ยังไม่ได้ยืนยันการเริ่มฝึกงานเกินกำหนด',
  HR_EVALUATE_D3: 'การฝึกงานสิ้นสุดแล้ว กรุณาประเมินผล',
  EVALUATE_ESCALATE_D14: 'ยังไม่ได้ประเมินผลการฝึกงานเกินกำหนด',
  HR_ISSUE_CERT_D3: 'กรุณาออกใบรับรองการฝึกงาน',
  ISSUE_CERT_ESCALATE_D14: 'ยังไม่ได้ออกใบรับรองเกินกำหนด',
  ADVISOR_DISPUTE_D3: 'ข้อโต้แย้งผลประเมินรออาจารย์พิจารณา',
  DISPUTE_ESCALATE_D7: 'ข้อโต้แย้งผลประเมินยังไม่ได้รับการพิจารณา',
  COMPANY_SUSPENDED_DECISION: 'บริษัทถูกระงับ กรุณาพิจารณาการฝึกงานที่กำลังดำเนินอยู่',
};

const detailLink = (path: string, id: string) => `${path}/item?id=${encodeURIComponent(id)}`;

@Injectable()
export class NotificationEvents implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly identity: IdentityClient,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all(
      EVENT_CATALOG.filter((event) => event.consumers.includes('notification')).map(
        ({ producer, type }) =>
          this.consumer.subscribe({
            producer,
            type,
            handler: (envelope, tx) => this.handle(envelope, tx),
          }),
      ),
    );
  }

  async handle(event: EventEnvelope, tx: Tx): Promise<void> {
    if (
      event.payload === null ||
      typeof event.payload !== 'object' ||
      Array.isArray(event.payload)
    ) {
      throw new InvalidMessageError('Invalid notification event payload');
    }
    if (event.type === 'UserDeletionRequested') {
      await this.deleteInbox(tx, (event.payload as UserDeletionRequestedPayload).user_id);
      return;
    }
    if (event.type === 'UserSuspended') {
      const payload = event.payload as UserSuspendedPayload;
      await this.lockRecipient(tx, payload.user_id);
      await tx.recipientState.updateMany({
        where: {
          recipientKey: recipientKey(payload.user_id),
          suspensionVersion: { lt: payload.entity_version },
        },
        data: { suspended: payload.suspended, suspensionVersion: payload.entity_version },
      });
      return;
    }
    if (event.type === 'AdvisorLinkChanged') {
      const payload = event.payload as AdvisorLinkChangedPayload;
      if (payload.link_status !== 'LINKED' && payload.link_status !== 'UNLINKED') return;
      const state = await this.lockRecipient(tx, payload.student_user_id);
      if (state.deleted || state.advisorLinkVersion >= payload.entity_version) return;
      await tx.recipientState.update({
        where: { recipientKey: recipientKey(payload.student_user_id) },
        data: { advisorLinkVersion: payload.entity_version },
      });
      if (payload.link_status === 'UNLINKED' && payload.changed_by === 'ADVISOR') {
        // Identity cancels the pending account and leaves no active student inbox.
        await this.deleteInbox(tx, payload.student_user_id);
        return;
      }
    }

    if (event.type === 'ReviewPublished') {
      // Legacy E11 events omitted change and are treated as publications.
      const change = 'change' in event.payload ? event.payload.change : 'PUBLISHED';
      if (change === 'REMOVED') return;
      if (change !== 'PUBLISHED') throw new InvalidMessageError('Invalid ReviewPublished change');

      const { review_id: reviewId } = event.payload as ReviewPublishedPayload;
      const inserted = await tx.reviewNotice.createMany({
        data: [{ reviewId }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return;
    }

    const notice = await this.notice(event);
    if (!notice?.recipients.length) return;
    const recipients = new Map<string, Recipient>();
    for (const recipient of notice.recipients) {
      const previous = recipients.get(recipient.id);
      recipients.set(recipient.id, {
        ...recipient,
        link: previous?.link ?? recipient.link,
        email: previous?.email || recipient.email,
      });
    }
    const ids = [...recipients.keys()].sort();
    const existing = await this.identity.existingUsers(ids, event.correlation_id);
    for (const id of ids) {
      if (!existing.has(id)) continue;
      const state = await this.lockRecipient(tx, id);
      if (state.deleted || state.suspended) continue;
      const recipient = recipients.get(id)!;
      await tx.notification.create({
        data: {
          userId: id,
          type: event.type,
          title: notice.title,
          body: notice.body,
          link: recipient.link,
          sourceEventId: event.event_id,
          ...(recipient.email
            ? { deliveries: { create: { channel: 'EMAIL', toUserId: id, status: 'PENDING' } } }
            : {}),
        },
      });
    }
  }

  private lockRecipient(tx: Tx, userId: string) {
    const key = recipientKey(userId);
    return tx.recipientState.upsert({
      where: { recipientKey: key },
      create: { recipientKey: key },
      update: { recipientKey: key },
    });
  }

  private async deleteInbox(tx: Tx, userId: string): Promise<void> {
    const key = recipientKey(userId);
    await tx.recipientState.upsert({
      where: { recipientKey: key },
      create: { recipientKey: key, deleted: true },
      update: { deleted: true },
    });
    await tx.notification.deleteMany({ where: { userId } });
  }

  private async notice(event: EventEnvelope): Promise<Notice | undefined> {
    const cid = event.correlation_id;
    const admins = async (link = '/admin/queue') =>
      (await this.identity.admins(cid)).map(({ user_id: id }) => ({ id, link }));
    const members = async (companyId: string, link: string) =>
      (await this.identity.members(companyId, cid)).map(({ user_id: id }) => ({ id, link }));
    switch (event.type) {
      case 'JobStatusChanged': {
        const p = event.payload as JobStatusChangedPayload;
        const title = jobStatusMessages[p.to_status];
        if (title)
          return {
            title,
            body: 'เปิดรายละเอียดประกาศของบริษัทเพื่อดูสถานะล่าสุด',
            recipients: (await members(p.company_id, detailLink('/hr/jobs', p.job_id))).map(
              (recipient) => ({
                ...recipient,
                email: p.to_status === 'ADMIN_REJECTED',
              }),
            ),
          };
        return;
      }
      case 'ReportThresholdReached': {
        const p = event.payload as ReportThresholdReachedPayload;
        return {
          title: 'ประกาศถูกรายงานครบเกณฑ์',
          body: 'มีรายการรายงานรอพิจารณา',
          recipients: await admins(detailLink('/admin/queue', p.queue_item_id)),
        };
      }
      case 'CompanyStatusChanged': {
        const p = event.payload as CompanyStatusChangedPayload;
        const title = companyStatusMessages[p.status];
        if (!title) return;
        const owner =
          p.owner_user_id ??
          (await this.identity.members(p.company_id, cid)).find(
            (member) => member.member_role === 'OWNER',
          )?.user_id;
        return {
          title,
          body: 'ตรวจสอบสถานะหรือปรับข้อมูลบริษัทในหน้าบัญชีบริษัท',
          recipients: owner ? [{ id: owner, link: '/hr/company' }] : [],
        };
      }
      case 'AdvisorLinkChanged': {
        const p = event.payload as AdvisorLinkChangedPayload;
        const linked = p.link_status === 'LINKED';
        const advisor = linked ? p.new_advisor_id : p.old_advisor_id;
        const recipients: Recipient[] = [];
        if (p.changed_by !== 'STUDENT')
          recipients.push({ id: p.student_user_id, link: '/student/profile' });
        if (advisor && p.changed_by !== 'ADVISOR')
          recipients.push({ id: advisor, link: '/advisor/students' });
        return {
          title: linked ? 'ผูกอาจารย์ที่ปรึกษาแล้ว' : 'ยกเลิกการผูกอาจารย์ที่ปรึกษาแล้ว',
          body: 'ข้อมูลอาจารย์ที่ปรึกษาของนักศึกษามีการเปลี่ยนแปลง',
          recipients,
        };
      }
      case 'ApplicationStatusChanged':
        return this.applicationNotice(event.payload as ApplicationStatusChangedPayload, cid);
      case 'ReviewModerationResult': {
        const p = event.payload as ReviewModerationResultPayload;
        if (p.decision === 'ADMIN_REMOVE')
          return {
            title: 'ผู้ดูแลระบบนำรีวิวออก',
            body: 'รีวิวนี้ไม่แสดงในหน้าบริษัทแล้ว',
            recipients: [{ id: p.student_user_id }],
          };
        return;
      }
      case 'ReviewPublished': {
        const p = event.payload as ReviewPublishedPayload;
        return {
          title: 'มีรีวิวของบริษัทใหม่',
          body: 'มีรีวิวการฝึกงานเผยแพร่ในหน้าบริษัท',
          recipients: await members(p.company_id, detailLink('/companies', p.company_id)),
        };
      }
      case 'CertificateIssued': {
        const p = event.payload as CertificateIssuedPayload;
        return {
          title: 'ออกใบรับรองการฝึกงานแล้ว',
          body: 'เปิดหน้าของคุณเพื่อดูใบรับรอง',
          recipients: [{ id: p.student_user_id, link: '/student/certificates' }],
        };
      }
      case 'CertificateRevoked': {
        const p = event.payload as CertificateRevokedPayload;
        return {
          title: 'ใบรับรองการฝึกงานถูกเพิกถอน',
          body: 'ตรวจสอบสถานะใบรับรองในหน้าของคุณ',
          recipients: [{ id: p.student_user_id, link: '/student/certificates' }],
        };
      }
      case 'ReminderDue': {
        const p = event.payload as ReminderDuePayload;
        const recipients: Recipient[] = p.audience.map(({ user_id: id, role }) => ({
          id,
          email: true,
          link:
            role === 'ADVISOR'
              ? advisorReminderLink(p.reminder_type)
              : p.context.application_id
                ? this.applicationLink(role, p.context.application_id)
                : undefined,
        }));
        if (escalations.has(p.reminder_type)) {
          recipients.push(...(await admins()).map((recipient) => ({ ...recipient, email: true })));
        }
        return {
          title: reminderMessages[p.reminder_type],
          body: `กำหนดวันที่ ${p.due_date} กรุณาตรวจสอบรายการที่เกี่ยวข้อง`,
          recipients,
        };
      }
      case 'ProblemReportCreated': {
        const p = event.payload as ProblemReportCreatedPayload;
        return {
          title: 'นักศึกษารายงานปัญหาการฝึกงาน',
          body: 'มีรายงานปัญหาใหม่ที่ต้องพิจารณา',
          recipients: [{ id: p.advisor_user_id }, ...(await admins())],
        };
      }
      case 'ConductReportCreated': {
        // E19 — บริษัทรายงานพฤติกรรมนักศึกษา: แจ้งเฉพาะอาจารย์ที่ปรึกษา (ไม่ส่งรายละเอียดใน Event/ข้อความ)
        const p = event.payload as ConductReportCreatedPayload;
        return {
          title: 'บริษัทรายงานพฤติกรรมนักศึกษา',
          body: 'มีรายงานพฤติกรรมนักศึกษาในความดูแลจากบริษัท เปิดเพื่อดูรายละเอียดและกดรับทราบ',
          recipients: [{ id: p.advisor_user_id, email: true, link: '/advisor/conduct-reports' }],
        };
      }
      case 'CompanyFlagChanged': {
        const p = event.payload as CompanyFlagChangedPayload;
        if (p.active)
          return {
            title: 'บริษัทถูกติดธงให้ตรวจสอบ',
            body: 'เปิดรายการธงบริษัทเพื่อดูรายละเอียด',
            recipients: await admins('/admin/flags'),
          };
        return;
      }
    }
  }

  private async applicationNotice(
    p: ApplicationStatusChangedPayload,
    cid: string,
  ): Promise<Notice | undefined> {
    const title = applicationStatusMessages[p.to_status];
    if (!title) return;
    const channels = applicationChannels(p);
    const recipients: Recipient[] = [];
    if (channels.student)
      recipients.push({
        id: p.student_user_id,
        email: channels.student === 'EMAIL',
        link: detailLink('/student/applications', p.application_id),
      });
    if (channels.advisor && p.advisor_user_id)
      recipients.push({
        id: p.advisor_user_id,
        email: channels.advisor === 'EMAIL',
        link: advisorLink(p.to_status),
      });
    if (channels.hr) {
      const ids =
        p.hr_user_ids ??
        (await this.identity.members(p.company_id, cid)).map((member) => member.user_id);
      for (const id of ids)
        recipients.push({
          id,
          email: channels.hr === 'EMAIL',
          link: detailLink('/hr/applicants', p.application_id),
        });
    }
    return {
      title,
      body: 'เปิดเพื่อดูรายละเอียดและดำเนินการต่อ',
      recipients: recipients.filter((recipient) => recipient.id !== p.actor_user_id),
    };
  }

  private applicationLink(role: string, id: string): string | undefined {
    if (role === 'STUDENT') return detailLink('/student/applications', id);
    if (role === 'COMPANY_HR') return detailLink('/hr/applicants', id);
  }
}
