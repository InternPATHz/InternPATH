import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import sinon from 'sinon';
import type { ApplicationStatus } from '../../generated/client';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import { QuotaRepairService } from '../../src/jobs/quota-repair.service';
import { SLA_INTERVAL_NAME, SlaSchedulerModule } from '../../src/jobs/sla-scheduler.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ApplicationStateMachine } from '../../src/state-machine/application-state-machine.service';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { QUOTA_LEASE_MS, QuotaLeaseService } from '../../src/state-machine/quota-lease.service';
import { StateMachineModule } from '../../src/state-machine/state-machine.module';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_JWT } from '../support/jwt';

/** OutboxWriter มาจาก MessagingModule (Global) ในแอปจริง — เทสต์ไม่ต่อ RabbitMQ จึงให้ตัวเขียนลงตาราง Outbox อย่างเดียว */
@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class OutboxOnlyModule {}

/*
 * QIR-01 / QIR-03 (PM ตัดสิน 2026-11-19): lease กันคำสั่งโควตาของใบเดียวกันซ้อนกัน + Scheduler ซ่อม Job ให้ตรงกับ Lifecycle
 * Postgres จริง + State Machine จริง • Job เป็นตัวปลอมที่จำลองสถานะการจองตาม api-contract §9 (#83) และหน่วง release ได้
 * ข้ามทั้งชุดเมื่อไม่มี Postgres (เหมือนเทสต์ DB อื่น)
 */
describe('Lifecycle — lease โควตา + ซ่อม Job (QIR-01/QIR-03, Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  let machine: ApplicationStateMachine;
  let lease: QuotaLeaseService;
  let repair: QuotaRepairService;
  const job = new FakeJobClient();
  const hr = { userId: randomUUID(), role: 'COMPANY_HR' as const };

  before(async function () {
    database = await createTestDatabase('lc_qlease');
    if (!database) this.skip();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_PUBLIC_KEY: TEST_JWT.publicKey, LIFECYCLE_DATABASE_URL: database!.url })],
        }),
        PrismaModule,
        LifecycleConfigModule,
        InternalModule,
        OutboxOnlyModule,
        StateMachineModule,
        SlaSchedulerModule,
      ],
    })
      .overrideProvider(JobInternalClient)
      .useValue(job)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    machine = app.get(ApplicationStateMachine);
    lease = app.get(QuotaLeaseService);
    repair = app.get(QuotaRepairService);
    // Runner ลงทะเบียน interval ตอนบูต — หยุดไว้ให้เทสต์เรียก runOnce เอง
    app.get(SchedulerRegistry).deleteInterval(SLA_INTERVAL_NAME);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(async () => {
    job.reset();
    job.strict = true;
    // ใบของเทสต์ก่อนหน้าไม่ปนกับรอบนี้ (repair ตรวจทุกใบที่ถือโควตาในฐาน)
    await prisma.application.updateMany({ where: { quotaReserved: true }, data: { quotaReserved: false } });
  });

  const seed = (status: ApplicationStatus, data: Record<string, unknown> = {}) =>
    prisma.application.create({
      data: { jobId: randomUUID(), companyId: randomUUID(), studentUserId: randomUUID(), advisorUserId: randomUUID(), status, ...data },
    });
  const reload = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });
  const today = () => bangkokToday(new Date());
  const accept = (id: string) =>
    machine.execute(id, {
      trigger: 'accept',
      actor: hr,
      input: { startDate: addDays(today(), 1), endDate: addDays(today(), 60) },
      correlationId: randomUUID(),
    });
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      return 'OK';
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };
  const until = async (condition: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // ------------------------------------------------------------------
  describe('lease (QIR-01)', () => {
    it('acquire ซ้อนไม่ได้ • คืนด้วย token อื่นไม่ปลดของผู้ถือ • หมดอายุแล้วยึดต่อได้', async () => {
      const a = await seed('PENDING');
      const first = await lease.acquire(a.id);
      expect(first).to.be.instanceOf(Date);
      expect(await lease.acquire(a.id)).to.equal(null);

      await lease.release(a.id, new Date(first!.getTime() + 1)); // token ไม่ตรง
      expect((await reload(a.id)).quotaOpUntil?.getTime()).to.equal(first!.getTime());
      expect(await lease.acquire(a.id)).to.equal(null);

      await lease.release(a.id, first!);
      expect((await reload(a.id)).quotaOpUntil).to.equal(null);

      // หมดอายุ ⇒ ผู้ถือเดิมไม่มีผลอีก และผู้อื่นยึดต่อได้
      const stale = await lease.acquire(a.id, new Date(Date.now() - QUOTA_LEASE_MS - 1_000));
      expect(stale).to.be.instanceOf(Date);
      const taken = await lease.acquire(a.id);
      expect(taken).to.be.instanceOf(Date);
      await lease.release(a.id, stale!); // ผู้ถือเก่าคืน ⇒ ต้องไม่ปลดของผู้ยึดต่อ
      expect((await reload(a.id)).quotaOpUntil?.getTime()).to.equal(taken!.getTime());
    });

    it('accept สำเร็จ ⇒ จอง Job 1 ครั้ง และคืน lease', async () => {
      const a = await seed('PENDING');
      await accept(a.id);
      expect(await reload(a.id)).to.include({ status: 'HR_ACCEPTED', quotaReserved: true, quotaOpUntil: null });
      expect(job.calls.map((c) => c.op)).to.deep.equal(['reserve']);
      expect(job.reservations.get(a.id)).to.equal('RESERVED');
    });

    it('QIR-01: accept B ซ้อนระหว่างที่ release ชดเชยของ A ยังค้าง ⇒ B ได้ 409 และไม่ชนกับ release เก่า • หลัง A จบ B ทำได้และ Job ยัง RESERVED', async () => {
      const a = await seed('PENDING');
      let openGate!: () => void;
      job.releaseGate = new Promise<void>((resolve) => (openGate = resolve));

      // A: reserve สำเร็จ แต่ Transaction ล้ม (Outbox E08) ⇒ release ชดเชยถูกหน่วงบนเครือข่าย
      const outbox = app.get(OutboxWriter);
      const add = sinon.stub(outbox, 'add').callThrough();
      add.onFirstCall().rejects(new Error('outbox down'));
      const pendingA = codeOf(accept(a.id));
      await until(() => job.calls.some((c) => c.op === 'release'), 'release ของ A ถูกส่งออก');
      add.restore();
      expect(job.reservations.get(a.id)).to.equal('RESERVED'); // release ยังไม่มีผล

      // B: ใบเดียวกัน ระหว่างที่ A ยังถือ lease
      expect(await codeOf(accept(a.id))).to.equal('STATE_CONFLICT');
      expect(job.calls.map((c) => c.op)).to.deep.equal(['reserve', 'release']); // B ไม่ได้เรียก Job เลย
      expect(await reload(a.id)).to.include({ status: 'PENDING', quotaReserved: false });

      // release ของ A มาถึง ⇒ A จบ (ล้มด้วย error เดิม) และคืน lease
      openGate();
      expect(await pendingA).to.equal('outbox down');
      expect(job.reservations.get(a.id)).to.equal('RELEASED');
      expect((await reload(a.id)).quotaOpUntil).to.equal(null);

      // B ลองใหม่หลัง A จบ ⇒ จองใหม่ได้ Job RESERVED ตรงกับที่ Lifecycle ถือ (ไม่มี release เก่าตามมา)
      await accept(a.id);
      expect(await reload(a.id)).to.include({ status: 'HR_ACCEPTED', quotaReserved: true });
      expect(job.reservations.get(a.id)).to.equal('RESERVED');
    });

    it('lease หมดอายุกลางทาง (process ล่ม) ⇒ accept ใหม่ยึดต่อได้ และ release เก่าที่มาหลังหมดอายุถูกซ่อน', async () => {
      const a = await seed('PENDING');
      // process ล่มระหว่าง compensation: ค้าง lease เก่าและ release ยังไม่ถูกส่ง/มาช้า
      await prisma.application.update({ where: { id: a.id }, data: { quotaOpUntil: new Date(Date.now() - 1_000) } });
      await accept(a.id); // B ยึด lease ที่หมดอายุแล้วได้
      expect(await reload(a.id)).to.include({ status: 'HR_ACCEPTED', quotaReserved: true, quotaOpUntil: null });

      // release เก่าของ A มาถึงหลังจากนั้น ⇒ Job ไม่มีการจอง ทั้งที่ Lifecycle ถือโควตา
      await job.releaseQuota(a.jobId, a.id, 'TRANSITION_FAILED');
      expect(job.reservations.get(a.id)).to.equal('RELEASED');

      const result = await repair.runOnce();
      expect(result).to.include({ scanned: 1, synced: 1, quotaFull: 0, failed: 0 });
      expect(job.reservations.get(a.id)).to.equal('RESERVED');
      expect(await reload(a.id)).to.include({ status: 'HR_ACCEPTED', quotaReserved: true });
    });
  });

  // ------------------------------------------------------------------
  describe('repair (QIR-01/QIR-03)', () => {
    it('Job ตรงกับ Lifecycle อยู่แล้ว (RESERVED/CONFIRMED) ⇒ ไม่เปลี่ยน ไม่ถอย CONFIRMED กลับ RESERVED', async () => {
      const reserved = await seed('ADVISOR_PENDING', { quotaReserved: true });
      const confirmed = await seed('IN_PROGRESS', { quotaReserved: true });
      job.reservations.set(reserved.id, 'RESERVED');
      job.reservations.set(confirmed.id, 'CONFIRMED');

      const result = await repair.runOnce();
      expect(result).to.include({ scanned: 2, synced: 2, quotaFull: 0, failed: 0 });
      expect(job.reservations.get(reserved.id)).to.equal('RESERVED');
      expect(job.reservations.get(confirmed.id)).to.equal('CONFIRMED');
    });

    it('QIR-03: IN_PROGRESS แต่ Job ค้าง RESERVED (confirm ล้มหลัง commit) ⇒ repair confirm', async () => {
      const a = await seed('IN_PROGRESS', { quotaReserved: true });
      job.reservations.set(a.id, 'RESERVED');
      const result = await repair.runOnce();
      expect(result).to.include({ synced: 1, failed: 0 });
      expect(job.reservations.get(a.id)).to.equal('CONFIRMED');
    });

    it('IN_PROGRESS แต่ Job เป็น RELEASED ⇒ จองใหม่แล้ว confirm', async () => {
      const a = await seed('IN_PROGRESS', { quotaReserved: true });
      job.reservations.set(a.id, 'RELEASED');
      await repair.runOnce();
      expect(job.calls.map((c) => c.op)).to.deep.equal(['reserve', 'confirm']);
      expect(job.reservations.get(a.id)).to.equal('CONFIRMED');
    });

    it('Job เป็น RELEASED แต่โควตาเต็ม ⇒ QUOTA_FULL ไม่ถือว่าซ่อมสำเร็จ • Lifecycle ไม่เปลี่ยนอะไร • มีที่ว่างแล้วรอบหน้าซ่อมได้', async () => {
      const a = await seed('HR_ACCEPTED', { quotaReserved: true });
      job.reservations.set(a.id, 'RELEASED');
      job.capacity = 0;

      const first = await repair.runOnce();
      expect(first).to.include({ scanned: 1, synced: 0, quotaFull: 1, failed: 0 });
      expect(job.reservations.get(a.id)).to.equal('RELEASED');
      expect(await reload(a.id)).to.include({ status: 'HR_ACCEPTED', quotaReserved: true, quotaOpUntil: null });

      job.capacity = 1;
      const second = await repair.runOnce();
      expect(second).to.include({ scanned: 1, synced: 1, quotaFull: 0 });
      expect(job.reservations.get(a.id)).to.equal('RESERVED');
    });

    it('Job ล่ม ⇒ นับ failed ไม่ throw ใบอื่นยังซ่อมต่อ • ลองใหม่รอบหน้า', async () => {
      const a = await seed('HR_ACCEPTED', { quotaReserved: true });
      const b = await seed('HR_ACCEPTED', { quotaReserved: true });
      job.reservations.set(a.id, 'RELEASED');
      job.reservations.set(b.id, 'RELEASED');
      const original = job.reserveQuota.bind(job);
      let calls = 0;
      job.reserveQuota = async (jobId: string, applicationId: string) => {
        calls += 1;
        if (calls === 1) throw new Error('job down');
        return original(jobId, applicationId);
      };
      try {
        const result = await repair.runOnce();
        expect(result).to.include({ scanned: 2, synced: 1, failed: 1 });
      } finally {
        job.reserveQuota = original;
      }
      expect((await repair.runOnce()).failed).to.equal(0);
      expect(job.reservations.get(a.id)).to.equal('RESERVED');
      expect(job.reservations.get(b.id)).to.equal('RESERVED');
    });

    it('ไม่ซ่อมใบที่ไม่ถือโควตา (quota_reserved = false) ไม่ว่าสถานะใด ⇒ ไม่เรียก Job เลย', async () => {
      await seed('HR_ACCEPTED', { quotaReserved: false });
      await seed('STUDENT_DECLINED', { quotaReserved: false });
      await seed('COMPLETED', { quotaReserved: false });
      const result = await repair.runOnce();
      expect(result).to.include({ scanned: 0, synced: 0 });
      expect(job.calls).to.have.length(0);
    });

    it('ใบที่มีคำสั่งถือ lease อยู่ ⇒ ข้ามรอบนี้ ไม่เรียก Job • lease หมดอายุแล้ว ⇒ ซ่อมได้', async () => {
      const a = await seed('HR_ACCEPTED', { quotaReserved: true });
      job.reservations.set(a.id, 'RELEASED');
      await prisma.application.update({ where: { id: a.id }, data: { quotaOpUntil: new Date(Date.now() + 30_000) } });
      const busy = await repair.runOnce();
      expect(busy).to.include({ scanned: 1, skipped: 1, synced: 0 });
      expect(job.calls).to.have.length(0);

      await prisma.application.update({ where: { id: a.id }, data: { quotaOpUntil: new Date(Date.now() - 1_000) } });
      const free = await repair.runOnce();
      expect(free).to.include({ synced: 1, skipped: 0 });
      expect((await reload(a.id)).quotaOpUntil).to.equal(null);
    });

    it('ซ่อมซ้ำหลายรอบเป็น no-op: Job ไม่ถูกหักซ้ำและไม่เปลี่ยนสถานะ', async () => {
      const a = await seed('ADVISOR_APPROVED', { quotaReserved: true });
      job.reservations.set(a.id, 'RELEASED');
      await repair.runOnce();
      await repair.runOnce();
      await repair.runOnce();
      expect(job.reservations.get(a.id)).to.equal('RESERVED');
      expect([...job.reservations.values()].filter((s) => s === 'RESERVED')).to.have.length(1);
    });
  });

  // ------------------------------------------------------------------
  describe('ขอบเขตหลัง start — Termination-before-Repair (JR regression)', () => {
    const HOUR = 3_600_000;
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR);

    it('สถานะหลัง start ที่ยังถือที่นั่ง (TERMINATED/ประเมิน/COMPLETED) แต่ Job เป็น RELEASED ⇒ repair จอง + confirm ให้เป็น CONFIRMED', async () => {
      const statuses: ApplicationStatus[] = ['TERMINATED', 'EVALUATED_PASS', 'COMPLETED', 'FAIL_DISPUTED'];
      const rows = [];
      for (const status of statuses) rows.push(await seed(status, { quotaReserved: true, statusChangedAt: hoursAgo(2) }));
      for (const row of rows) job.reservations.set(row.id, 'RELEASED');

      const result = await repair.runOnce();
      expect(result).to.include({ scanned: 4, synced: 4, quotaFull: 0, failed: 0 });
      for (const row of rows) expect(job.reservations.get(row.id), row.status).to.equal('CONFIRMED');
    });

    it('ลำดับของ JR: release เก่าทำให้ Job RELEASED ⇒ start ได้ confirm 409 ⇒ ซ่อมทันที Job เป็น CONFIRMED ก่อนที่จะยุติการฝึกได้', async () => {
      const a = await seed('ADVISOR_APPROVED', {
        quotaReserved: true,
        startDate: today(),
        endDate: addDays(today(), 60),
      });
      job.reservations.set(a.id, 'RELEASED');

      const result = await machine.execute(a.id, {
        trigger: 'start',
        actor: hr,
        patch: { actualStartDate: today() },
        correlationId: randomUUID(),
      });
      expect(result.application.status).to.equal('IN_PROGRESS');
      expect(result.quotaFailures).to.deep.equal([]);
      expect(job.calls.map((c) => c.op)).to.deep.equal(['confirm', 'reserve', 'confirm']);
      expect(job.reservations.get(a.id)).to.equal('CONFIRMED');
    });

    it('ซ่อมทันทีไม่ได้เพราะที่นั่งถูกคนอื่นจองไปก่อน (QUOTA_FULL) ⇒ ใบยัง IN_PROGRESS • ยุติการฝึกแล้ว repair ก็ยังไม่ผ่าน (ไม่หลอกตัวเอง) • มีที่ว่างแล้วจึงซ่อมได้', async () => {
      const a = await seed('ADVISOR_APPROVED', {
        quotaReserved: true,
        startDate: today(),
        endDate: addDays(today(), 60),
      });
      job.reservations.set(a.id, 'RELEASED');
      job.capacity = 0; // ที่นั่งสุดท้ายถูกคนอื่นจองไปแล้ว

      const result = await machine.execute(a.id, {
        trigger: 'start',
        actor: hr,
        patch: { actualStartDate: today() },
        correlationId: randomUUID(),
      });
      expect(result.application.status).to.equal('IN_PROGRESS');
      expect(result.quotaFailures).to.have.length(1);
      expect(job.reservations.get(a.id)).to.equal('RELEASED');

      // นักศึกษายุติการฝึกก่อน Scheduler ซ่อม — ต้องยังอยู่ในขอบเขต repair
      await prisma.application.update({ where: { id: a.id }, data: { status: 'TERMINATED' } });
      const stuck = await repair.runOnce();
      expect(stuck).to.include({ scanned: 1, synced: 0, quotaFull: 1 });
      expect(await reload(a.id)).to.include({ status: 'TERMINATED', quotaReserved: true, quotaSyncedAt: null });

      job.capacity = 1;
      const fixed = await repair.runOnce();
      expect(fixed).to.include({ scanned: 1, synced: 1, quotaFull: 0 });
      expect(job.reservations.get(a.id)).to.equal('CONFIRMED');
    });

    it('ใบที่ควรเป็น CONFIRMED: ยืนยันตรงแล้วและสถานะนิ่ง ≥ 1 ชั่วโมง ⇒ จด quota_synced_at และไม่ตรวจซ้ำ', async () => {
      const a = await seed('TERMINATED', { quotaReserved: true, statusChangedAt: hoursAgo(2) });
      job.reservations.set(a.id, 'CONFIRMED');
      expect(await repair.runOnce()).to.include({ scanned: 1, synced: 1 });
      expect((await reload(a.id)).quotaSyncedAt).to.be.instanceOf(Date);

      job.calls.length = 0;
      expect(await repair.runOnce()).to.include({ scanned: 0, synced: 0 });
      expect(job.calls).to.have.length(0);
    });

    it('ไม่ข้ามถาวร (JR): จดแล้ว แต่ release เก่ามาช้าหลังจดทำให้ Job เป็น RELEASED ⇒ ภายใน 24 ชม. ข้าม • เกิน 24 ชม. ตรวจซ้ำและซ่อมกลับเป็น CONFIRMED', async () => {
      const a = await seed('COMPLETED', { quotaReserved: true, statusChangedAt: hoursAgo(3) });
      job.reservations.set(a.id, 'CONFIRMED');
      await repair.runOnce();
      expect((await reload(a.id)).quotaSyncedAt).to.be.instanceOf(Date);

      // release เก่าที่ค้างบนเครือข่ายมาถึงหลังจากจดแล้ว
      await job.releaseQuota(a.jobId, a.id, 'TRANSITION_FAILED');
      expect(job.reservations.get(a.id)).to.equal('RELEASED');

      job.calls.length = 0;
      expect(await repair.runOnce()).to.include({ scanned: 0, synced: 0 }); // ยังอยู่ในช่วงข้าม
      expect(job.reservations.get(a.id)).to.equal('RELEASED');

      await prisma.application.update({ where: { id: a.id }, data: { quotaSyncedAt: hoursAgo(25) } });
      expect(await repair.runOnce()).to.include({ scanned: 1, synced: 1 });
      expect(job.reservations.get(a.id)).to.equal('CONFIRMED');
      const refreshed = (await reload(a.id)).quotaSyncedAt!;
      expect(Date.now() - refreshed.getTime()).to.be.lessThan(60_000); // จดค่าใหม่
    });

    it('สถานะเพิ่งเปลี่ยน (< 1 ชั่วโมง) ⇒ ซ่อมแล้วแต่ยังไม่จด ตรวจต่อรอบหน้า (กัน release เก่าที่ตามมา)', async () => {
      const a = await seed('IN_PROGRESS', { quotaReserved: true, statusChangedAt: new Date() });
      job.reservations.set(a.id, 'RESERVED');
      expect(await repair.runOnce()).to.include({ scanned: 1, synced: 1 });
      expect(job.reservations.get(a.id)).to.equal('CONFIRMED');
      expect((await reload(a.id)).quotaSyncedAt).to.equal(null);
      expect(await repair.runOnce()).to.include({ scanned: 1, synced: 1 }); // ยังตรวจอยู่

      // release เก่ามาถึงทีหลังการซ่อมรอบแรก ⇒ รอบถัดไปจับได้
      await job.releaseQuota(a.jobId, a.id, 'TRANSITION_FAILED');
      expect(job.reservations.get(a.id)).to.equal('RELEASED');
      await repair.runOnce();
      expect(job.reservations.get(a.id)).to.equal('CONFIRMED');
    });

    it('ใบที่ยังรอยืนยัน (HR_ACCEPTED/ADVISOR_*) ตรวจทุกรอบและไม่จด quota_synced_at', async () => {
      const a = await seed('ADVISOR_PENDING', { quotaReserved: true, statusChangedAt: hoursAgo(5) });
      job.reservations.set(a.id, 'RESERVED');
      await repair.runOnce();
      expect(await repair.runOnce()).to.include({ scanned: 1 });
      expect((await reload(a.id)).quotaSyncedAt).to.equal(null);
      expect(job.reservations.get(a.id)).to.equal('RESERVED'); // ไม่ confirm ก่อน start
    });
  });
});
