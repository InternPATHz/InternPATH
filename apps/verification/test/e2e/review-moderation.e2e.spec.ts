import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@internpath/contracts';
import { configureApp } from '@internpath/common';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import request from 'supertest';
import { VerificationModule } from '../../src/verification.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { brokerReachableOrSkip, brokerUrl, dropBrokerSandbox, collectOutbound, publishRaw, purgeVerificationQueues, type Collector } from '../support/amqp';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { envelope, reviewSubmitted } from '../support/events';
import { createJwtKit } from '../support/jwt';

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('e2e: review-moderation — ตรวจรีวิว/รายงานรีวิว/E15 ผ่าน RabbitMQ จริง', function () {
  this.timeout(90000);
  let db: TestDatabase;
  let app: INestApplication;
  let prisma: PrismaService;
  let collector: Collector;
  const kit = createJwtKit();
  const admin = () => ({ Authorization: `Bearer ${kit.token({ role: 'PLATFORM_ADMIN' })}` });
  const student = () => ({ Authorization: `Bearer ${kit.token({ role: 'STUDENT' })}` });
  let started = false;

  before(async function () {
    await brokerReachableOrSkip(this);
    await dbReachableOrSkip(this);
    started = true;
    await purgeVerificationQueues();
    db = await createTestDatabase();
    collector = await collectOutbound(['ReviewModerationResult']);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              RABBITMQ_URL: brokerUrl(),
              VERIFICATION_DATABASE_URL: db.url,
              VERIFICATION_DIRECT_URL: db.url,
              JWT_PUBLIC_KEY: kit.publicKey,
              QUEUE_SLA_HOURS_NORMAL: 48,
              QUEUE_SLA_HOURS_FAST: 12,
            }),
          ],
        }),
        VerificationModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  after(async () => {
    if (!started) { await dropBrokerSandbox(); return; }
    await app?.close();
    await collector?.close();
    await purgeVerificationQueues();
    await dropBrokerSandbox();
    await db?.drop();
  });

  const send = (producer: 'lifecycle' | 'identity', type: string, env: EventEnvelope<string, unknown>) =>
    publishRaw(`${producer}.${type}`, Buffer.from(JSON.stringify(env)), env.event_id);
  const http = () => request(app.getHttpServer());
  const msgs = (pred: (p: any) => boolean): any[] => collector.messages.filter((m) => m.type === 'ReviewModerationResult' && pred(m.payload)).map((m) => m.payload);

  it('E09 ทุกฉบับ (สะอาด/มีเบอร์โทร) ⇒ E10 PUBLISH ทันที ไม่มีรายการคิว', async () => {
    const clean = reviewSubmitted();
    await send('lifecycle', 'ReviewSubmitted', envelope('ReviewSubmitted', clean, 'lifecycle'));
    await waitFor(() => msgs((x) => x.review_id === clean.review_id).length === 1, 'PUBLISH');
    expect(msgs((x) => x.review_id === clean.review_id)[0]).to.include({ decision: 'PUBLISH', decided_by: 'SYSTEM', student_user_id: clean.student_user_id });

    const phone = reviewSubmitted({ content: { body: 'ติดต่อพี่ได้ที่ 081-234-5678' } });
    await send('lifecycle', 'ReviewSubmitted', envelope('ReviewSubmitted', phone, 'lifecycle'));
    await waitFor(() => msgs((x) => x.review_id === phone.review_id).length === 1, 'PUBLISH (มีเบอร์โทร)');
    expect(msgs((x) => x.review_id === phone.review_id)[0]).to.include({ decision: 'PUBLISH' });
    expect(await prisma.queueItem.count({ where: { targetId: phone.review_id } })).to.equal(0);
  });

  it('รายงานรีวิวที่เผยแพร่แล้ว → รายการ REVIEW_REPORT → Admin remove-review ⇒ E10 ADMIN_REMOVE (มี REPORTED)', async () => {
    const review = reviewSubmitted();
    await send('lifecycle', 'ReviewSubmitted', envelope('ReviewSubmitted', review, 'lifecycle'));
    await waitFor(() => msgs((x) => x.review_id === review.review_id).length === 1, 'PUBLISH');

    await http().post(`/v1/reviews/${review.review_id}/reports`).set(student()).send({ reason: 'รีวิวนี้ใส่ร้ายบริษัท' }).expect(201);
    const list = await http().get('/v1/admin/queue?type=REVIEW_REPORT').set(admin()).expect(200);
    const item = list.body.data.find((x: any) => x.target_id === review.review_id);
    await http().post(`/v1/admin/queue/${item.id}/actions/remove-review`).set(admin()).send({ reason: 'ไม่เป็นความจริง' }).expect(204);
    await waitFor(() => msgs((x) => x.review_id === review.review_id && x.decision === 'ADMIN_REMOVE').length === 1, 'ADMIN_REMOVE');
    const out = msgs((x) => x.review_id === review.review_id && x.decision === 'ADMIN_REMOVE')[0];
    expect(out.reasons.map((r: any) => r.code)).to.deep.equal(['REPORTED', 'ADMIN']);
  });

  it('E15 ของผู้เขียนรีวิว ⇒ student_user_id เป็นรหัสนิรนาม รีวิวที่เผยแพร่แล้วคงเนื้อหา', async () => {
    const review = reviewSubmitted({ content: { body: 'โทร 081-234-5678 ได้เลย' } });
    await send('lifecycle', 'ReviewSubmitted', envelope('ReviewSubmitted', review, 'lifecycle'));
    await waitFor(() => msgs((x) => x.review_id === review.review_id).length === 1, 'PUBLISH');

    const anonymous = randomUUID();
    const deletion = envelope('UserDeletionRequested', {
      user_id: review.student_user_id,
      role: 'STUDENT',
      requested_at: new Date().toISOString(),
      mode: 'DELETE_AND_ANONYMIZE' as const,
      anonymous_actor_id: anonymous,
    }, 'identity');
    await send('identity', 'UserDeletionRequested', deletion);
    await waitFor(async () => (await prisma.reviewModeration.findUnique({ where: { reviewId: review.review_id } }))?.studentUserId === anonymous, 'anonymized');
    const row = await prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: review.review_id } });
    expect(row).to.include({ status: 'PASSED' });
    expect(row.body).to.include('081');
  });
});
