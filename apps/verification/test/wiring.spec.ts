import type { OutboxTx, ProcessedEventsTx } from '@internpath/common';
import { expect } from 'chai';
import type { Tx } from '../src/prisma/types';
import { createTestApp } from './support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from './support/db';

describe('wiring', () => {
  it('Prisma tx เข้ากับ OutboxTx และ ProcessedEventsTx ของ libs/common (ตรวจตอนคอมไพล์)', () => {
    // ถ้าไม่เข้ากัน ts-node จะล้มที่สองบรรทัดนี้ — ให้ปรับ interface ใน libs/common ให้หลวมลง ไม่ import Prisma เข้า lib
    const t = {} as Tx;
    const outbox: OutboxTx = t;
    const processed: ProcessedEventsTx = t;
    expect(outbox).to.equal(processed);
  });

  describe('PrismaModule (Postgres จริง)', function () {
    this.timeout(60000);
    let db: TestDatabase;

    before(async function () {
      await dbReachableOrSkip(this);
      db = await createTestDatabase();
    });
    after(async () => {
      await db?.drop();
    });

    it('เปิด app ด้วยฐานข้อมูลทดสอบแล้ว $queryRaw SELECT 1 ได้ และปิดแล้วไม่ค้าง', async () => {
      const { app, prisma } = await createTestApp({ imports: [], db });
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT 1::int AS n`;
      expect(rows[0].n).to.equal(1);
      const t0 = Date.now();
      await app.close();
      expect(Date.now() - t0).to.be.lessThan(2000);
    });
  });
});
