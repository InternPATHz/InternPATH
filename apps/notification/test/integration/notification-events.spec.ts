import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { processDelivery, type EventConsumer } from '@internpath/common';
import type {
  ApplicationStatusChangedPayload,
  EventEnvelope,
  UserContact,
} from '@internpath/contracts';
import { expect } from 'chai';
import { PrismaClient, type Prisma } from '../../generated/client';
import { applicationChannels } from '../../src/events/consumers/application-recipients';
import { NotificationEvents } from '../../src/events/consumers/notification-events';
import type { IdentityClient } from '../../src/internal/identity-client';
import { NotificationMailService } from '../../src/modules/mail/notification-mail.service';
import type { PrismaService } from '../../src/prisma.service';

describe('Notification E08 recipient matrix', () => {
  const channels = (
    to_status: ApplicationStatusChangedPayload['to_status'],
    from_status?: ApplicationStatusChangedPayload['from_status'],
  ) => applicationChannels({ from_status, to_status } as ApplicationStatusChangedPayload);

  it('implements the documented channel and prior-status rules', () => {
    expect(channels('PENDING')).to.deep.equal({ hr: 'EMAIL' });
    expect(channels('IN_PROGRESS')).to.deep.equal({ student: 'EMAIL', advisor: 'IN_APP' });
    expect(channels('HR_REJECTED', 'PENDING')).to.deep.equal({ student: 'EMAIL' });
    expect(channels('ADVISOR_REJECTED')).to.deep.equal({ student: 'EMAIL', hr: 'IN_APP' });
    expect(channels('OFFER_RESCINDED', 'HR_ACCEPTED')).to.deep.equal({ student: 'EMAIL' });
    expect(channels('OFFER_RESCINDED', 'ADVISOR_PENDING')).to.deep.equal({
      student: 'EMAIL',
      advisor: 'IN_APP',
    });
    expect(channels('WITHDRAWN', 'ADVISOR_APPROVED')).to.deep.equal({
      hr: 'IN_APP',
      advisor: 'IN_APP',
    });
    expect(channels('EXPIRED', 'ADVISOR_PENDING')).to.deep.equal({
      student: 'IN_APP',
      hr: 'IN_APP',
    });
    expect(channels('EXPIRED', 'ADVISOR_APPROVED')).to.deep.equal({
      student: 'IN_APP',
      hr: 'IN_APP',
      advisor: 'IN_APP',
    });
  });
});

describe('Notification event consumption (PostgreSQL)', function () {
  this.timeout(60_000);
  const student = randomUUID();
  const advisor = randomUUID();
  const admin = randomUUID();
  const hr = randomUUID();
  const company = randomUUID();
  let maint: PrismaClient | undefined;
  let db: PrismaClient | undefined;
  const dbName = `notification_it_${randomUUID().replace(/-/g, '')}`;
  let created = false;
  let service: NotificationEvents;
  const contact = (id: string): UserContact => ({
    user_id: id,
    email: 'local@example.test',
    full_name: 'Local',
  });

  before(async function () {
    const connection = process.env.NOTIFICATION_IT_ADMIN_URL;
    if (!connection) return this.skip();
    const url = new URL(connection);
    if (
      !['postgresql:', 'postgres:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/postgres' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'NOTIFICATION_IT_ADMIN_URL must point to a local postgres maintenance database',
      );
    }
    maint = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      // The name contains only a fixed prefix and a locally generated hex UUID.
      await maint.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      created = true;
      url.pathname = `/${dbName}`;
      const datasourceUrl = url.toString();
      execFileSync(
        process.execPath,
        [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
        {
          cwd: resolve(__dirname, '../..'),
          stdio: 'pipe',
          timeout: 30000,
          env: {
            ...process.env,
            NOTIFICATION_DATABASE_URL: datasourceUrl,
            NOTIFICATION_DIRECT_URL: datasourceUrl,
          },
        },
      );
      db = new PrismaClient({ datasourceUrl });
    } catch {
      throw new Error('Could not initialize disposable Notification test database');
    }
    const identity: Pick<IdentityClient, 'admins' | 'members' | 'existingUsers' | 'contact'> = {
      admins: async () => [{ user_id: admin }],
      members: async () => [{ user_id: hr, member_role: 'OWNER' }],
      existingUsers: async (ids) => new Set(ids),
      contact: async (id) => contact(id),
    };
    service = new NotificationEvents(
      {} as EventConsumer<Prisma.TransactionClient>,
      identity as IdentityClient,
    );
  });

  after(async () => {
    try {
      await db?.$disconnect();
      if (created) await maint?.$executeRawUnsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    } finally {
      await maint?.$disconnect();
    }
  });

  const envelope = (
    type: string,
    payload: object,
    producer: EventEnvelope['producer'] = 'identity',
  ): EventEnvelope => ({
    type,
    producer,
    payload,
    event_id: randomUUID(),
    correlation_id: randomUUID(),
    version: 1,
    occurred_at: new Date().toISOString(),
  });

  function processEvent(event: EventEnvelope) {
    return processDelivery({
      raw: Buffer.from(JSON.stringify(event)),
      retryCount: 0,
      queue: `notification.${event.type}`,
      sub: {
        type: event.type,
        producer: event.producer,
        handler: (env, tx: Prisma.TransactionClient) => service.handle(env, tx),
      },
      runInTransaction: (handler) => db!.$transaction(handler),
      maxRetries: 3,
    });
  }

  async function deliver(event: EventEnvelope) {
    expect((await processEvent(event)).kind).to.equal('ack');
    return db!.notification.findMany({
      where: { sourceEventId: event.event_id },
      include: { deliveries: true },
    });
  }

  it('deduplicates LINKED, uses in-app only, clears a cancelled inbox, and discards old link events', async () => {
    const linked = envelope('AdvisorLinkChanged', {
      student_user_id: student,
      new_advisor_id: advisor,
      link_status: 'LINKED',
      changed_by: 'ADVISOR',
      entity_version: 2,
    });
    const notified = await deliver(linked);
    expect(notified.map((notice) => notice.userId)).to.deep.equal([student]);
    expect(notified[0].deliveries).to.deep.equal([]);
    expect(await deliver(linked)).to.have.length(1);
    const cancelled = envelope('AdvisorLinkChanged', {
      student_user_id: student,
      old_advisor_id: advisor,
      link_status: 'UNLINKED',
      changed_by: 'ADVISOR',
      entity_version: 3,
    });
    expect(await deliver(cancelled)).to.deep.equal([]);
    expect(await deliver(linked)).to.deep.equal([]);
    expect(await deliver({ ...linked, event_id: randomUUID() })).to.deep.equal([]);
  });

  it('skips E07 with a link_status outside the contract for an active student', async () => {
    // Fresh active student and a complete payload, so link_status is the only invalid field.
    const activeStudent = randomUUID();
    const oldAdvisor = randomUUID();
    const event = envelope('AdvisorLinkChanged', {
      student_user_id: activeStudent,
      old_advisor_id: oldAdvisor,
      link_status: 'NONE',
      changed_by: 'ADMIN',
      entity_version: 2,
      changed_at: new Date().toISOString(),
    });
    expect(await deliver(event)).to.deep.equal([]);
    expect(
      await db!.notification.count({ where: { userId: { in: [activeStudent, oldAdvisor] } } }),
    ).to.equal(0);
  });

  it('skips retired decisions, notifies the student for ADMIN_REMOVE, and adds Admin for an empty escalation', async () => {
    const otherStudent = randomUUID();
    expect(
      await deliver(
        envelope('JobStatusChanged', { company_id: company, to_status: 'AUTO_REJECTED' }, 'job'),
      ),
    ).to.deep.equal([]);
    expect(
      await deliver(
        envelope(
          'ReviewModerationResult',
          { decision: 'HOLD', student_user_id: otherStudent },
          'verification',
        ),
      ),
    ).to.deep.equal([]);
    const removed = await deliver(
      envelope(
        'ReviewModerationResult',
        { review_id: randomUUID(), decision: 'ADMIN_REMOVE', student_user_id: otherStudent },
        'verification',
      ),
    );
    expect(removed.map((notification) => notification.userId)).to.deep.equal([otherStudent]);
    const reminder = await deliver(
      envelope(
        'ReminderDue',
        {
          audience: [],
          context: {},
          due_date: '2026-11-21',
          reminder_type: 'ADVISOR_APPROVE_ESCALATE_ADMIN_D7',
        },
        'lifecycle',
      ),
    );
    expect(reminder.map((notification) => notification.userId)).to.deep.equal([admin]);
    expect(reminder[0].deliveries[0]).to.include({ status: 'PENDING', toUserId: admin });
    // อาจารย์ได้ลิงก์ไปหน้าที่ต้องทำตามชนิดการเตือน (UAT รอบ 5 — เดิม link ว่าง)
    for (const [reminderType, link] of [
      ['EVALUATE_ESCALATE_D14', '/advisor/evaluations'],
      ['ADVISOR_APPROVE_D3', '/advisor/approvals'],
      ['COMPANY_SUSPENDED_DECISION', '/advisor/students'],
    ] as const) {
      const toAdvisor = await deliver(
        envelope(
          'ReminderDue',
          {
            audience: [{ role: 'ADVISOR', user_id: advisor }],
            context: { application_id: randomUUID() },
            due_date: '2026-11-21',
            reminder_type: reminderType,
          },
          'lifecycle',
        ),
      );
      const forAdvisor = toAdvisor.find((notification) => notification.userId === advisor);
      expect(forAdvisor?.link, reminderType).to.equal(link);
    }
    const rejected = await deliver(
      envelope(
        'JobStatusChanged',
        {
          company_id: company,
          job_id: randomUUID(),
          to_status: 'ADMIN_REJECTED',
        },
        'job',
      ),
    );
    expect(rejected[0].deliveries[0]).to.include({ status: 'PENDING', toUserId: hr });
  });

  const reviewPublished = (reviewId = randomUUID()) => ({
    review_id: reviewId,
    company_id: company,
    rating: 5,
    company_review_count: 3,
    company_rating_sum: 13,
    entity_version: 1,
    published_at: new Date().toISOString(),
  });

  it('E19 ConductReportCreated notifies only the advisor (in-app + email, link to conduct reports) without the detail', async () => {
    const advisor = randomUUID();
    const event = envelope('ConductReportCreated', {
      conduct_report_id: randomUUID(), application_id: randomUUID(), student_user_id: randomUUID(), advisor_user_id: advisor,
      company_id: randomUUID(), category: 'ATTENDANCE', created_at: new Date().toISOString(),
    }, 'lifecycle');
    const notice = await deliver(event);
    expect(notice.map((row) => row.userId)).to.deep.equal([advisor]);
    expect(notice[0]).to.include({ link: '/advisor/conduct-reports' });
    expect(notice[0].deliveries.length).to.be.greaterThan(0);
    expect(await deliver(event)).to.have.length(1);
  });

  it('notifies HR once for E11 PUBLISHED, including redelivery with the same or a new event ID', async () => {
    const payload = { ...reviewPublished(), change: 'PUBLISHED' };
    const published = envelope('ReviewPublished', payload, 'lifecycle');
    const notice = await deliver(published);
    expect(notice.map((row) => row.userId)).to.deep.equal([hr]);
    expect(await deliver(published)).to.have.length(1);
    expect(await deliver(envelope('ReviewPublished', payload, 'lifecycle'))).to.deep.equal([]);
    expect(
      await deliver(
        envelope(
          'ReviewPublished',
          {
            ...payload,
            change: 'REMOVED',
            company_review_count: 2,
            company_rating_sum: 8,
            entity_version: 2,
          },
          'lifecycle',
        ),
      ),
    ).to.deep.equal([]);
  });

  it('skips E11 REMOVED even when it arrives before E10 or E11 PUBLISHED', async () => {
    const payload = reviewPublished();
    const removed = envelope(
      'ReviewPublished',
      {
        ...payload,
        change: 'REMOVED',
        company_review_count: 2,
        company_rating_sum: 8,
        entity_version: 2,
      },
      'lifecycle',
    );
    expect(await deliver(removed)).to.deep.equal([]);
    expect(await deliver(removed)).to.deep.equal([]);
    expect(await db!.reviewNotice.findUnique({ where: { reviewId: payload.review_id } })).to.equal(
      null,
    );
    const e10 = await deliver(
      envelope(
        'ReviewModerationResult',
        {
          review_id: payload.review_id,
          decision: 'ADMIN_REMOVE',
          student_user_id: randomUUID(),
        },
        'verification',
      ),
    );
    expect(e10).to.have.length(1);
    expect(
      (
        await deliver(envelope('ReviewPublished', { ...payload, change: 'PUBLISHED' }, 'lifecycle'))
      ).map((row) => row.userId),
    ).to.deep.equal([hr]);
  });

  it('treats legacy E11 without change as PUBLISHED', async () => {
    const payload = reviewPublished();
    await deliver(
      envelope(
        'ReviewModerationResult',
        {
          review_id: payload.review_id,
          decision: 'ADMIN_REMOVE',
          student_user_id: randomUUID(),
        },
        'verification',
      ),
    );
    const legacy = envelope('ReviewPublished', payload, 'lifecycle');
    expect((await deliver(legacy)).map((row) => row.userId)).to.deep.equal([hr]);
    expect(await deliver(legacy)).to.have.length(1);
  });

  it('dead-letters E11 with an invalid change instead of notifying HR', async () => {
    for (const change of [null, 'UNKNOWN']) {
      const event = envelope('ReviewPublished', { ...reviewPublished(), change }, 'lifecycle');
      expect(await processEvent(event)).to.include({
        kind: 'dead-letter',
        reason: 'invalid_message',
      });
      expect(await db!.notification.count({ where: { sourceEventId: event.event_id } })).to.equal(
        0,
      );
    }
  });

  it('persists pending mail, excludes the actor and suspended recipients, and deletes delivery rows with the inbox', async () => {
    const secondStudent = randomUUID();
    const app = {
      application_id: randomUUID(),
      company_id: company,
      student_user_id: secondStudent,
      advisor_user_id: advisor,
      actor_user_id: hr,
      to_status: 'ADVISOR_APPROVED',
    };
    const send = envelope('ApplicationStatusChanged', app, 'lifecycle');
    const queued = await deliver(send);
    expect(queued.map((notification) => notification.userId)).to.deep.equal([secondStudent]);
    expect(queued[0].deliveries[0]).to.include({
      status: 'PENDING',
      toUserId: secondStudent,
      attempts: 0,
    });
    await deliver(
      envelope('UserSuspended', { user_id: secondStudent, entity_version: 2, suspended: true }),
    );
    await deliver(
      envelope('UserSuspended', { user_id: secondStudent, entity_version: 1, suspended: false }),
    );
    expect(await deliver(envelope('ApplicationStatusChanged', app, 'lifecycle'))).to.deep.equal([]);
    await deliver(envelope('UserDeletionRequested', { user_id: secondStudent }));
    expect(
      await db!.deliveryLog.findUnique({ where: { id: queued[0].deliveries[0].id } }),
    ).to.equal(null);
    expect(await deliver(envelope('ApplicationStatusChanged', app, 'lifecycle'))).to.deep.equal([]);
  });
  it('ส่งอีเมลที่ค้างเป็นชุด เรียงเก่าก่อน (FIFO) และหยุดชุดเมื่อส่งไม่สำเร็จ (UAT รอบ 5 NT-25)', async () => {
    // ผู้รับใหม่ — `student` ของเทสต์ก่อนหน้าอาจถูกระงับ/ลบแล้ว
    const mailUser = randomUUID();
    await db!.deliveryLog.deleteMany({ where: { channel: 'EMAIL' } });
    const base = Date.now() - 60_000;
    const titles = ['mail-1', 'mail-2', 'mail-3'];
    // สร้างกลับลำดับ เพื่อให้ลำดับ insert/UUID ไม่ตรงกับเวลา created_at
    for (const [index, title] of [...titles.entries()].reverse()) {
      await db!.notification.create({
        data: {
          userId: mailUser,
          type: 'MailOrder',
          title,
          body: 'body',
          sourceEventId: randomUUID(),
          createdAt: new Date(base + index * 1000),
          deliveries: { create: { channel: 'EMAIL', toUserId: mailUser, status: 'PENDING' } },
        },
      });
    }
    const identity = { contact: async (id: string) => contact(id) } as unknown as IdentityClient;
    const mail = new NotificationMailService(db as unknown as PrismaService, identity, {} as never);
    const sent: string[] = [];
    let fail = false;
    (mail as unknown as { send: (email: string, n: { title: string }) => Promise<void> }).send =
      async (_email, n) => {
        if (fail) throw new Error('smtp down');
        sent.push(n.title);
      };
    expect(await mail.deliverBatch()).to.equal(3);
    expect(sent).to.deep.equal(titles);
    expect(await db!.deliveryLog.count({ where: { channel: 'EMAIL', status: 'SENT' } })).to.equal(
      3,
    );

    await db!.notification.create({
      data: {
        userId: mailUser,
        type: 'MailOrder',
        title: 'mail-4',
        body: 'body',
        sourceEventId: randomUUID(),
        deliveries: { create: { channel: 'EMAIL', toUserId: mailUser, status: 'PENDING' } },
      },
    });
    fail = true;
    expect(await mail.deliverBatch()).to.equal(0);
    const failed = await db!.deliveryLog.findFirstOrThrow({
      where: { channel: 'EMAIL', status: 'FAILED' },
    });
    expect(failed.attempts, 'ไม่ลองซ้ำในรอบเดียวกัน').to.equal(1);
  });
});
