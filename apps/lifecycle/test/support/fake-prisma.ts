import { randomUUID } from 'node:crypto';
import type { Application } from '../../generated/client';

/**
 * Prisma ปลอมในหน่วยความจำ สำหรับเทสต์หน่วยของ State Machine (ไม่ต้องมี Postgres)
 * รองรับเฉพาะรูปแบบ where/data ที่โค้ดใช้จริง + จำลอง partial unique index "ยืนยันได้ทีละ 1 ที่"
 * และ rollback ของ `$transaction` — พฤติกรรมของ Postgres จริงทดสอบใน test/db/state-machine.spec.ts
 */

type Row = Record<string, any>;
type Where = Record<string, any>;

const CONFIRMED = ['ADVISOR_PENDING', 'ADVISOR_APPROVED', 'IN_PROGRESS'];

function matchValue(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    if ('in' in cond) return cond.in.includes(actual);
    if ('not' in cond) return !matchValue(actual, cond.not);
    if ('gte' in cond) return actual instanceof Date && actual.getTime() >= cond.gte.getTime();
  }
  return actual === cond;
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => matchValue(row[key], cond));
}

function applyData(row: Row, data: Row): Row {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      next[key] = (next[key] ?? 0) + value.increment;
    } else {
      next[key] = value;
    }
  }
  return next;
}

function sortRows<T extends Row>(rows: T[], orderBy?: Row | Row[]): T[] {
  const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const [key, dir] = Object.entries(order)[0];
      const av = a[key] instanceof Date ? a[key].getTime() : a[key];
      const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (av === bv) continue;
      const cmp = av === null || av === undefined ? -1 : bv === null || bv === undefined ? 1 : av < bv ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

function pick(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

function table(state: FakeState, name: keyof FakeState['tables'], options: { uniqueConfirmed?: boolean } = {}) {
  const rows = () => state.tables[name];
  const checkUnique = (candidate: Row) => {
    if (!options.uniqueConfirmed || !CONFIRMED.includes(candidate.status)) return;
    const clash = rows().find(
      (r) => r.id !== candidate.id && r.studentUserId === candidate.studentUserId && CONFIRMED.includes(r.status),
    );
    if (clash) {
      throw Object.assign(new Error('Unique constraint failed on the fields: (`student_user_id`)'), {
        code: 'P2002',
        meta: { modelName: 'Application', target: ['student_user_id'] },
      });
    }
  };
  return {
    async findUnique({ where }: { where: Where }) {
      return pick(rows().find((r) => matches(r, where)));
    },
    async findUniqueOrThrow({ where }: { where: Where }) {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error('No record found');
      return { ...row };
    },
    async findFirst({ where, orderBy, select }: { where?: Where; orderBy?: Row | Row[]; select?: Row }) {
      return pick(sortRows(rows().filter((r) => matches(r, where)), orderBy)[0], select);
    },
    async findMany({ where, orderBy, select }: { where?: Where; orderBy?: Row | Row[]; select?: Row } = {}) {
      return sortRows(rows().filter((r) => matches(r, where)), orderBy).map((r) => pick(r, select));
    },
    async count({ where }: { where?: Where } = {}) {
      return rows().filter((r) => matches(r, where)).length;
    },
    async create({ data }: { data: Row }) {
      const row = { id: randomUUID(), ...data };
      rows().push(row);
      return { ...row };
    },
    async update({ where, data }: { where: Where; data: Row }) {
      const index = rows().findIndex((r) => matches(r, where));
      if (index < 0) throw new Error('Record to update not found');
      const next = applyData(rows()[index], data);
      checkUnique(next);
      rows()[index] = next;
      return { ...next };
    },
    async updateMany({ where, data }: { where: Where; data: Row }) {
      const targets = rows().filter((r) => matches(r, where));
      for (const row of targets) {
        const next = applyData(row, data);
        checkUnique(next);
        rows()[rows().indexOf(row)] = next;
      }
      return { count: targets.length };
    },
  };
}

export interface FakeState {
  tables: {
    application: Row[];
    statusHistory: Row[];
    outboxEvent: Row[];
    evaluation: Row[];
    failDispute: Row[];
    reapplyUnlock: Row[];
  };
}

export function createFakePrisma() {
  const state: FakeState = {
    tables: { application: [], statusHistory: [], outboxEvent: [], evaluation: [], failDispute: [], reapplyUnlock: [] },
  };
  const client = {
    state,
    application: table(state, 'application', { uniqueConfirmed: true }),
    statusHistory: table(state, 'statusHistory'),
    outboxEvent: table(state, 'outboxEvent'),
    evaluation: table(state, 'evaluation'),
    failDispute: table(state, 'failDispute'),
    reapplyUnlock: table(state, 'reapplyUnlock'),
    transactions: 0,
    /** ใช้กับ `SELECT … FOR UPDATE` เท่านั้น — เก็บค่าพารามิเตอร์ไว้ตรวจ */
    lockedStudents: [] as string[],
    async $queryRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
      client.lockedStudents.push(String(values[0]));
      return [];
    },
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      client.transactions++;
      const snapshot = structuredClone(state.tables);
      try {
        return await fn(client);
      } catch (error) {
        // rollback: คืนสถานะก่อนเริ่ม Transaction
        state.tables = snapshot;
        throw error;
      }
    },
  };
  return client;
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;

/** ใบสมัครตัวอย่าง — ใส่ค่าครบทุกคอลัมน์ของ model `Application` */
export function makeApplication(overrides: Partial<Application> = {}): Application {
  const now = new Date('2026-06-01T00:00:00Z');
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    companyId: randomUUID(),
    studentUserId: randomUUID(),
    advisorUserId: randomUUID(),
    resumeId: null,
    resumeConsentId: null,
    coverLetter: null,
    majorMismatch: false,
    status: 'PENDING',
    frozen: false,
    frozenAt: null,
    slaPausedSeconds: 0,
    companySuspendedDecision: null,
    flaggedForAdvisor: false,
    startDate: null,
    endDate: null,
    actualStartDate: null,
    actualEndDate: null,
    quotaReserved: false,
    quotaOpUntil: null,
    statusChangedAt: now,
    terminatedBy: null,
    terminateReason: null,
    withdrawnReason: null,
    rescindReason: null,
    advisorRejectReason: null,
    academicResult: null,
    academicNote: null,
    academicRecordedAt: null,
    reevaluationUsed: false,
    version: 1,
    entityVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
