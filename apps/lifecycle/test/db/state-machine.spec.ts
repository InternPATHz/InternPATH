import { OutboxWriter } from '@internpath/common';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../generated/client';
import {
  ApplicationTransitionService,
  type TransitionCommand,
} from '../../src/state-machine/application-transition.service';
import { mapApplicationUniqueViolation } from '../../src/state-machine/errors';
import { StatusHistoryWriter } from '../../src/state-machine/status-history.writer';
import { createTestDatabase, type TestDatabase } from '../support/db';

const CONFIG = { minActualDays: 30, disputeWindowDays: 7, noEvaluationAfterDays: 14 };

describe('State Machine บน Postgres จริง (concurrency + partial unique index)', function () {
  this.timeout(90_000);
  let database: TestDatabase | undefined;
  let prisma: PrismaClient;
  let service: ApplicationTransitionService;

  before(async function () {
    database = await createTestDatabase('lc_sm');
    if (!database) this.skip();
    prisma = new PrismaClient({ datasourceUrl: database.url, transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
    service = new ApplicationTransitionService(new OutboxWriter(), new StatusHistoryWriter());
  });

  after(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  const create = (data: { status: any; studentUserId?: string; jobId?: string; advisorUserId?: string; frozen?: boolean }) =>
    prisma.application.create({
      data: {
        jobId: data.jobId ?? randomUUID(),
        companyId: randomUUID(),
        studentUserId: data.studentUserId ?? randomUUID(),
        advisorUserId: data.advisorUserId ?? randomUUID(),
        status: data.status,
        frozen: data.frozen ?? false,
      },
    });

  /** เปลี่ยนสถานะใน Transaction ของตัวเอง (เหมือน orchestrator) — คืน code ของ error หรือ 'OK' */
  const run = async (id: string, command: Omit<TransitionCommand, 'correlationId'>): Promise<string> => {
    try {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.application.findUniqueOrThrow({ where: { id } });
        await service.apply(tx, fresh, { correlationId: randomUUID(), ...command }, new Date(), CONFIG);
      });
      return 'OK';
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };

  const countsFor = async (id: string) => ({
    history: await prisma.statusHistory.count({ where: { entityId: id } }),
    outbox: await prisma.outboxEvent.count({ where: { aggregateId: id } }),
  });

  it('ยิงเปลี่ยนสถานะพร้อมกัน: ผู้ชนะ 1 ราย อีกฝ่าย 409 STATE_CONFLICT, history/outbox มีแถวเดียว', async () => {
    const app = await create({ status: 'PENDING' });
    const results = await Promise.all([
      run(app.id, { trigger: 'withdraw', actor: { userId: app.studentUserId, role: 'STUDENT' } }),
      run(app.id, { trigger: 'reject', actor: { userId: randomUUID(), role: 'COMPANY_HR' } }),
      run(app.id, { trigger: 'expire', actor: { userId: null, role: 'SYSTEM' } }),
    ]);
    expect(results.filter((r) => r === 'OK')).to.have.length(1);
    expect(results.filter((r) => r === 'STATE_CONFLICT')).to.have.length(2);
    expect(await countsFor(app.id)).to.deep.equal({ history: 1, outbox: 1 });
    const row = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.version).to.equal(2);
    expect(row.entityVersion).to.equal(2);
  });

  it('ยืนยัน 2 ข้อเสนอพร้อมกัน: ได้ที่เดียว ไม่ deadlock และอีกใบถูก STUDENT_DECLINED', async () => {
    const studentUserId = randomUUID();
    const a = await create({ status: 'HR_ACCEPTED', studentUserId });
    const b = await create({ status: 'HR_ACCEPTED', studentUserId });
    const student = { userId: studentUserId, role: 'STUDENT' as const };
    const results = await Promise.all([
      run(a.id, { trigger: 'confirm-offer', actor: student }),
      run(b.id, { trigger: 'confirm-offer', actor: student }),
    ]);
    expect(results.filter((r) => r === 'OK')).to.have.length(1);
    expect(results.find((r) => r !== 'OK')).to.be.oneOf(['STATE_CONFLICT', 'ALREADY_CONFIRMED_ELSEWHERE']);
    const statuses = (await prisma.application.findMany({ where: { studentUserId } })).map((r) => r.status).sort();
    expect(statuses).to.deep.equal(['ADVISOR_PENDING', 'STUDENT_DECLINED']);
  });

  it('partial unique index "ยืนยันได้ทีละ 1 ที่" ชนจริง ⇒ แปลงเป็น 403 ALREADY_CONFIRMED_ELSEWHERE', async () => {
    const studentUserId = randomUUID();
    await create({ status: 'ADVISOR_APPROVED', studentUserId });
    const second = await create({ status: 'HR_ACCEPTED', studentUserId });
    let mapped: string | undefined;
    try {
      await prisma.application.updateMany({ where: { id: second.id }, data: { status: 'ADVISOR_PENDING' } });
    } catch (error) {
      mapped = mapApplicationUniqueViolation(error)?.code;
    }
    expect(mapped).to.equal('ALREADY_CONFIRMED_ELSEWHERE');
  });

  it('partial unique index "ห้ามสมัครซ้ำประกาศเดิม" ชนจริง ⇒ แปลงเป็น 409 ALREADY_APPLIED', async () => {
    const studentUserId = randomUUID();
    const jobId = randomUUID();
    await create({ status: 'PENDING', studentUserId, jobId });
    let mapped: string | undefined;
    try {
      await create({ status: 'PENDING', studentUserId, jobId });
    } catch (error) {
      mapped = mapApplicationUniqueViolation(error)?.code;
    }
    expect(mapped).to.equal('ALREADY_APPLIED');
  });

  it('Guard ใน Transaction เห็นใบที่ยืนยันแล้ว ⇒ 403 ALREADY_CONFIRMED_ELSEWHERE และไม่เขียน history/outbox', async () => {
    const studentUserId = randomUUID();
    await create({ status: 'IN_PROGRESS', studentUserId });
    const offer = await create({ status: 'HR_ACCEPTED', studentUserId });
    expect(await run(offer.id, { trigger: 'confirm-offer', actor: { userId: studentUserId, role: 'STUDENT' } })).to.equal(
      'ALREADY_CONFIRMED_ELSEWHERE',
    );
    expect(await countsFor(offer.id)).to.deep.equal({ history: 0, outbox: 0 });
  });

  it('ประกาศถูก Freeze ⇒ นักศึกษายืนยันข้อเสนอ/อาจารย์อนุมัติไม่ได้ (409 JOB_FROZEN) และไม่เขียน history/outbox (README UAT-26)', async () => {
    const studentUserId = randomUUID();
    const advisorUserId = randomUUID();
    const offer = await create({ status: 'HR_ACCEPTED', studentUserId, frozen: true });
    expect(await run(offer.id, { trigger: 'confirm-offer', actor: { userId: studentUserId, role: 'STUDENT' } })).to.equal('STATE_CONFLICT');
    const waiting = await create({ status: 'ADVISOR_PENDING', studentUserId: randomUUID(), advisorUserId, frozen: true });
    expect(await run(waiting.id, { trigger: 'approve', actor: { userId: advisorUserId, role: 'ADVISOR' } })).to.equal('STATE_CONFLICT');
    expect(await countsFor(offer.id)).to.deep.equal({ history: 0, outbox: 0 });
    expect(await countsFor(waiting.id)).to.deep.equal({ history: 0, outbox: 0 });
  });
});
