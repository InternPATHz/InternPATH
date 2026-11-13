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
import { brokerReachableOrSkip, brokerUrl, collectOutbound, publishRaw, purgeVerificationQueues, type Collector } from '../support/amqp';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { envelope, statusChanged, submitted } from '../support/events';
import { createJwtKit } from '../support/jwt';

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

describe('e2e: รายงานประกาศ, ระงับอัตโนมัติ และธง UNDER_REVIEW ผ่าน RabbitMQ จริง', function () {
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
    collector = await collectOutbound(['JobVerified', 'ReportThresholdReached', 'CompanyFlagChanged']);
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
    if (!started) return;
    await app?.close();
    await collector?.close();
    await purgeVerificationQueues();
    await db?.drop();
  });

  const send = (type: string, env: EventEnvelope<string, unknown>) => publishRaw(`job.${type}`, Buffer.from(JSON.stringify(env)), env.event_id);
  const http = () => request(app.getHttpServer());
  /** payload ของ Event ที่เก็บได้ (กรองตามชนิดและเงื่อนไข) */
  const msgs = (type: string, pred: (p: any) => boolean): any[] => collector.messages.filter((m) => m.type === type && pred(m.payload)).map((m) => m.payload);
  const jobStatus = (jobId: string, companyId: string, to: string, from: string, version = 2) =>
    send('JobStatusChanged', envelope('JobStatusChanged', statusChanged({ job_id: jobId, company_id: companyId, from_status: from, to_status: to, reason_code: undefined, entity_version: version })));

  it('รายงาน 3 บัญชี → E04 → Admin ยกคำร้อง → JobVerified(RESTORE)', async () => {
    const p = submitted();
    await send('JobSubmitted', envelope('JobSubmitted', p));
    await waitFor(() => msgs('JobVerified', (x) => x.job_id === p.job_id).length === 1, 'APPROVE');
    await jobStatus(p.job_id, p.company_id, 'PUBLISHED', 'VERIFYING');
    await waitFor(async () => (await prisma.jobSnapshot.count({ where: { jobId: p.job_id } })) === 1, 'job_snapshots');

    for (let i = 0; i < 3; i++) {
      await http().post(`/v1/jobs/${p.job_id}/reports`).set(student()).send({ category: 'SCAM_OR_FEE', detail: 'ประกาศนี้เรียกเก็บเงินค่าสมัครจากนักศึกษา' }).expect(201);
    }
    await waitFor(() => msgs('ReportThresholdReached', (x) => x.job_id === p.job_id).length === 1, 'E04');
    const e04 = msgs('ReportThresholdReached', (x) => x.job_id === p.job_id)[0];
    expect(e04).to.include({ job_id: p.job_id, company_id: p.company_id, report_count: 3 });

    const list = await http().get('/v1/admin/queue?type=JOB_REPORT').set(admin()).expect(200);
    const item = list.body.data.find((x: any) => x.target_id === p.job_id);
    expect(item.id).to.equal(e04.queue_item_id);
    await http().post(`/v1/admin/queue/${item.id}/actions/dismiss-report`).set(admin()).send({ reason: 'ประกาศปกติ' }).expect(204);
    await waitFor(() => msgs('JobVerified', (x) => x.job_id === p.job_id && x.decision === 'RESTORE').length === 1, 'RESTORE');
    expect(msgs('JobVerified', (x) => x.decision === 'RESTORE')[0]).to.include({ decided_by: 'ADMIN', is_appeal: false });
  });

  it('บริษัทถูกตีกลับ 3 ครั้ง → E18 active → E01 ถัดไปคะแนนต่ำได้ผลเหลือง → Admin เคลียร์ธง → E18 inactive', async () => {
    const company = randomUUID();
    await jobStatus(randomUUID(), company, 'AUTO_REJECTED', 'VERIFYING');
    await jobStatus(randomUUID(), company, 'ADMIN_REJECTED', 'PENDING_REVIEW');
    await jobStatus(randomUUID(), company, 'SUSPENDED', 'PUBLISHED');
    await waitFor(() => msgs('CompanyFlagChanged', (x) => x.company_id === company && x.active === true).length === 1, 'E18 active');
    expect(msgs('CompanyFlagChanged', (x) => x.company_id === company)[0]).to.include({ flag: 'UNDER_REVIEW', trigger_count: 3, set_by: 'SYSTEM' });

    const next = submitted({ company_id: company, company_flag_under_review: true });
    await send('JobSubmitted', envelope('JobSubmitted', next));
    await waitFor(() => msgs('JobVerified', (x) => x.job_id === next.job_id).length === 1, 'ผลตรวจบริษัทติดธง');
    const verdict = msgs('JobVerified', (x) => x.job_id === next.job_id)[0];
    expect(verdict).to.include({ decision: 'PENDING_REVIEW', risk_level: 'LOW' });
    expect(verdict.reasons.map((r: any) => r.code)).to.include('COMPANY_UNDER_REVIEW');

    const list = await http().get('/v1/admin/queue?type=COMPANY_ACCOUNT').set(admin()).expect(200);
    const item = list.body.data.find((x: any) => x.target_id === company);
    expect(item).to.include({ status: 'OPEN', priority: 'NORMAL' });
    await http().post(`/v1/admin/queue/${item.id}/actions/company-clear-flag`).set(admin()).send({ reason: 'ตรวจบัญชีแล้วปกติ' }).expect(204);
    await waitFor(() => msgs('CompanyFlagChanged', (x) => x.company_id === company && x.active === false).length === 1, 'E18 inactive');
    expect(msgs('CompanyFlagChanged', (x) => x.company_id === company && x.active === false)[0]).to.include({ set_by: 'ADMIN', entity_version: 2 });
  });
});
