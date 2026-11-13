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
import { brokerReachableOrSkip, brokerUrl, collectJobVerified, messageCount, publishRaw, purgeVerificationQueues, type Collector } from '../support/amqp';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { LONG, PHONE, companyChanged, envelope, statusChanged, submitted } from '../support/events';
import { createJwtKit } from '../support/jwt';

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('e2e: ตรวจประกาศงานผ่าน RabbitMQ จริง (VerificationModule เต็มระบบ)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let app: INestApplication;
  let prisma: PrismaService;
  let collector: Collector;
  const kit = createJwtKit();
  const admin = () => ({ Authorization: `Bearer ${kit.token({ role: 'PLATFORM_ADMIN' })}` });
  const hr = (companyId: string) => ({ Authorization: `Bearer ${kit.token({ role: 'COMPANY_HR', company_id: companyId })}` });

  let started = false; // false เมื่อ before ถูกข้าม (ไม่มี infra) — after ต้องไม่แตะ RabbitMQ/DB

  before(async function () {
    await brokerReachableOrSkip(this);
    await dbReachableOrSkip(this);
    started = true;
    await purgeVerificationQueues();
    db = await createTestDatabase();
    collector = await collectJobVerified();
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
    await app.init(); // ต่อ RabbitMQ, เริ่ม relay, ประกาศคิว/subscribe ของทุก consumer
    prisma = moduleRef.get(PrismaService);
  });

  after(async () => {
    if (!started) return;
    await app?.close();
    await collector?.close();
    await purgeVerificationQueues();
    await db?.drop();
  });

  const send = (type: string, producer: 'job' | 'identity', env: EventEnvelope<string, unknown>) =>
    publishRaw(`${producer}.${type}`, Buffer.from(JSON.stringify(env)), env.event_id);
  const verifiedFor = (jobId: string) => collector.messages.filter((m) => m.type === 'JobVerified' && m.payload.job_id === jobId);
  const http = () => request(app.getHttpServer());

  it('demo สามสี: สะอาด → APPROVE, มีเบอร์โทร → PENDING_REVIEW (เข้าคิว), คำต้องห้าม → AUTO_REJECT พร้อมเหตุผล', async () => {
    const green = submitted();
    const yellow = submitted({}, { description: LONG + PHONE });
    const red = submitted({}, { description: LONG + ' ต้องจ่ายค่ามัดจำ' });
    for (const p of [green, yellow, red]) await send('JobSubmitted', 'job', envelope('JobSubmitted', p));

    await waitFor(() => [green, yellow, red].every((p) => verifiedFor(p.job_id).length === 1), 'JobVerified ครบสามฉบับ');
    const decision = (p: typeof green) => verifiedFor(p.job_id)[0].payload;
    expect(decision(green)).to.deep.include({ decision: 'APPROVE', risk_level: 'LOW', decided_by: 'SYSTEM' });
    expect(decision(yellow)).to.deep.include({ decision: 'PENDING_REVIEW', risk_level: 'MEDIUM' });
    expect(decision(red)).to.deep.include({ decision: 'AUTO_REJECT', risk_level: 'HIGH' });
    expect(decision(red).reasons.find((r: any) => r.code === 'BLACKLIST_HARD').matched_text).to.equal('ค่ามัดจำ');
    expect(verifiedFor(green.job_id)[0].producer).to.equal('verification');

    const queue = await http().get('/v1/admin/queue?type=JOB_REVIEW').set(admin()).expect(200);
    expect(queue.body.data.map((x: any) => x.target_id)).to.include(yellow.job_id);
    expect(queue.body.data.map((x: any) => x.target_id)).to.not.include(green.job_id);
    expect(queue.body.data.map((x: any) => x.target_id)).to.not.include(red.job_id);
  });

  it('อุทธรณ์ครบวงจร: ประกาศแดง → HR อุทธรณ์ → APPEAL_ACCEPTED → Admin อนุมัติรายการ JOB_APPEAL → ADMIN_APPROVE', async () => {
    const red = submitted({}, { description: LONG + ' ลงทุนกับเรา' });
    await send('JobSubmitted', 'job', envelope('JobSubmitted', red));
    await waitFor(() => verifiedFor(red.job_id).length === 1, 'AUTO_REJECT');

    await http()
      .post(`/v1/verification/jobs/${red.job_id}/appeal`)
      .set(hr(red.company_id))
      .send({ statement: 'ขออุทธรณ์เนื่องจากข้อความถูกตีความผิดพลาด ไม่มีการเรียกเก็บเงินใดๆ' })
      .expect(201);
    await waitFor(() => verifiedFor(red.job_id).length === 2, 'APPEAL_ACCEPTED');
    expect(verifiedFor(red.job_id)[1].payload).to.deep.include({ decision: 'APPEAL_ACCEPTED', is_appeal: true });

    const items = await http().get('/v1/admin/queue?type=JOB_APPEAL').set(admin()).expect(200);
    const item = items.body.data.find((x: any) => x.target_id === red.job_id);
    expect(item).to.include({ is_appeal: true, status: 'OPEN' });
    await http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(admin()).expect(204);
    await waitFor(() => verifiedFor(red.job_id).length === 3, 'ADMIN_APPROVE');
    expect(verifiedFor(red.job_id)[2].payload).to.deep.include({ decision: 'ADMIN_APPROVE', decided_by: 'ADMIN', is_appeal: true });
  });

  it('แก้ประกาศแล้วตรวจซ้ำ: E01 EDIT ใหม่ของประกาศที่ยังเปิดคิวอยู่ → รายการเก่า SUPERSEDED และผลใหม่ออกตามปกติ', async () => {
    const first = submitted({}, { description: LONG + PHONE });
    await send('JobSubmitted', 'job', envelope('JobSubmitted', first));
    await waitFor(() => verifiedFor(first.job_id).length === 1, 'รอบแรก');
    const second = submitted(
      { job_id: first.job_id, company_id: first.company_id, submission_kind: 'EDIT', submitted_at: new Date(Date.now() + 1000).toISOString() },
      { description: LONG + PHONE + ' ต่อ 123' },
    );
    await send('JobSubmitted', 'job', envelope('JobSubmitted', second));
    await waitFor(() => verifiedFor(first.job_id).length === 2, 'รอบสอง');

    const items = await prisma.queueItem.findMany({ where: { targetId: first.job_id }, orderBy: { createdAt: 'asc' } });
    expect(items.map((i) => [i.status, i.resolution])).to.deep.equal([['RESOLVED', 'SUPERSEDED'], ['OPEN', null]]);
  });

  it('E03 VERIFY_TIMEOUT และ E05 ผ่านบรอกเกอร์: รายการคิว origin VERIFY_TIMEOUT พร้อมชื่อบริษัทจาก snapshot', async () => {
    const company = companyChanged({ snapshot: { name: 'บริษัท อีทูอี จำกัด', university_partner: false, verified_badge: true } });
    await send('CompanyStatusChanged', 'identity', envelope('CompanyStatusChanged', company, 'identity'));
    const s = statusChanged({ company_id: company.company_id, submission_id: randomUUID() });
    await send('JobStatusChanged', 'job', envelope('JobStatusChanged', s));

    await waitFor(async () => (await prisma.queueItem.count({ where: { targetId: s.job_id } })) === 1, 'รายการ timeout');
    const items = await http().get('/v1/admin/queue?page_size=100').set(admin()).expect(200);
    const item = items.body.data.find((x: any) => x.target_id === s.job_id);
    expect(item).to.include({ company_name: 'บริษัท อีทูอี จำกัด', risk_level: null });
    const detail = await http().get(`/v1/admin/queue/${item.id}`).set(admin()).expect(200);
    expect(detail.body).to.include({ origin: 'VERIFY_TIMEOUT' });
  });

  it('Event เสียไม่ทำให้ service หยุด: JSON พัง → DLQ แล้ว E01 ปกติที่ตามมายังถูกประมวลผล', async () => {
    await publishRaw('job.JobSubmitted', Buffer.from('{not json'));
    const ok = submitted();
    await send('JobSubmitted', 'job', envelope('JobSubmitted', ok));
    await waitFor(() => verifiedFor(ok.job_id).length === 1, 'E01 ปกติหลังข้อความเสีย');
    await waitFor(async () => (await messageCount('verification.JobSubmitted.dlq')) >= 1, 'ข้อความเสียอยู่ใน DLQ');
  });
});
