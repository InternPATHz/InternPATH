import { randomUUID } from 'node:crypto';
import { processDelivery, type Subscription } from '@internpath/common';
import { expect } from 'chai';
import { CompanySnapshotService } from '../../src/company/company-snapshot.service';
import type { Tx } from '../../src/prisma/types';
import {
  companyEntitlementEvent,
  companyFlagEvent,
  companyStatusEvent,
  companySubscriptions,
  type CompanyEvent,
} from '../support/company-events';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { eventually } from '../support/wait';

describe('Job company snapshots and shared delivery transactions (PostgreSQL)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let subscriptions: Map<string, Subscription<Tx>>;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    subscriptions = await companySubscriptions(new CompanySnapshotService());
  });
  after(async () => {
    await db?.drop();
  });

  const deliver = (
    env: CompanyEvent,
    transform?: (tx: Tx) => Tx,
    handler?: Subscription<Tx>['handler'],
  ) => {
    const sub = subscriptions.get(env.type)!;
    return processDelivery<Tx>({
      raw: Buffer.from(JSON.stringify(env)),
      retryCount: 0,
      maxRetries: 3,
      queue: `job.${env.type}`,
      sub: { ...sub, handler: handler ?? sub.handler },
      runInTransaction: (fn) =>
        db.prisma.$transaction((tx) => fn(transform ? transform(tx) : tx), {
          maxWait: 10000,
          timeout: 30000,
        }),
    });
  };
  const markerCount = (env: CompanyEvent) =>
    db.prisma.processedEvent.count({
      where: { eventId: env.event_id, consumer: `job.${env.type}` },
    });

  const cases = [
    {
      label: 'E05',
      model: 'companySnapshot',
      make: companyStatusEvent,
      read: (id: string) => db.prisma.companySnapshot.findUnique({ where: { companyId: id } }),
      readAll: (ids: string[]) =>
        db.prisma.companySnapshot.findMany({ where: { companyId: { in: ids } } }),
    },
    {
      label: 'E06',
      model: 'companyEntitlement',
      make: companyEntitlementEvent,
      read: (id: string) => db.prisma.companyEntitlement.findUnique({ where: { companyId: id } }),
      readAll: (ids: string[]) =>
        db.prisma.companyEntitlement.findMany({ where: { companyId: { in: ids } } }),
    },
    {
      label: 'E18',
      model: 'companyFlag',
      make: companyFlagEvent,
      read: (id: string) => db.prisma.companyFlag.findUnique({ where: { companyId: id } }),
      readAll: (ids: string[]) =>
        db.prisma.companyFlag.findMany({ where: { companyId: { in: ids } } }),
    },
  ] as const;

  for (const c of cases) {
    it(`${c.label}: creates once, accepts higher versions, and ignores lower/equal versions without touching timestamps`, async () => {
      const id = randomUUID();
      expect(await deliver(c.make(id, 1))).to.deep.equal({ kind: 'ack' });
      expect(await c.read(id)).to.include({ entityVersion: 1 });
      expect(await deliver(c.make(id, 3))).to.deep.equal({ kind: 'ack' });
      const latest = await c.read(id);
      expect(latest).to.include({ entityVersion: 3 });
      for (const version of [2, 3, 1]) {
        const event = c.make(id, version);
        expect(await deliver(event)).to.deep.equal({ kind: 'ack' });
        expect(await c.read(id)).to.deep.equal(latest);
        expect(await markerCount(event)).to.equal(1);
      }
      expect(await c.readAll([id])).to.have.length(1);
    });

    it(`${c.label}: duplicate event_id is handled once, even with a changed higher-version payload`, async () => {
      const id = randomUUID();
      const event = c.make(id, 1);
      const duplicate = { ...c.make(id, 99), event_id: event.event_id };
      let calls = 0;
      const handler: Subscription<Tx>['handler'] = async (env, tx) => {
        calls++;
        await subscriptions.get(env.type)!.handler(env, tx);
      };
      expect(await deliver(event, undefined, handler)).to.deep.equal({ kind: 'ack' });
      expect(await deliver(duplicate, undefined, handler)).to.deep.equal({ kind: 'ack' });
      expect(calls).to.equal(1);
      expect(await markerCount(event)).to.equal(1);
      expect(await c.read(id)).to.include({ entityVersion: 1 });
    });

    it(`${c.label}: concurrent duplicate event IDs commit one marker and call the handler once`, async () => {
      const event = c.make(randomUUID(), 1);
      let calls = 0;
      const handler: Subscription<Tx>['handler'] = async (env, tx) => {
        calls++;
        await subscriptions.get(env.type)!.handler(env, tx);
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => deliver(event, undefined, handler)),
      );
      expect(results).to.deep.equal(Array.from({ length: 8 }, () => ({ kind: 'ack' })));
      expect(calls).to.equal(1);
      expect(await markerCount(event)).to.equal(1);
    });

    it(`${c.label}: failed handler rolls back the snapshot and processed marker; the same event can retry`, async () => {
      const event = c.make(randomUUID(), 1);
      const failed: Subscription<Tx>['handler'] = async (env, tx) => {
        await subscriptions.get(env.type)!.handler(env, tx);
        throw new Error('Intentional failure after the snapshot write');
      };
      expect(await deliver(event, undefined, failed)).to.deep.equal({
        kind: 'retry',
        nextCount: 1,
      });
      expect(await c.read(event.payload.company_id)).to.equal(null);
      expect(await markerCount(event)).to.equal(0);
      expect(await deliver(event)).to.deep.equal({ kind: 'ack' });
      expect(await c.read(event.payload.company_id)).to.include({ entityVersion: 1 });
      expect(await markerCount(event)).to.equal(1);
    });

    it(`${c.label}: concurrent v1/v2 deliveries finish at v2`, async () => {
      const id = randomUUID();
      expect(await Promise.all([deliver(c.make(id, 1)), deliver(c.make(id, 2))])).to.deep.equal([
        { kind: 'ack' },
        { kind: 'ack' },
      ]);
      expect(await c.read(id)).to.include({ entityVersion: 2 });
    });

    it(`${c.label}: 40 concurrent first-insert races all retain v2`, async () => {
      const ids = Array.from({ length: 40 }, () => randomUUID());
      const results = await Promise.all(
        ids.flatMap((id) => [deliver(c.make(id, 1)), deliver(c.make(id, 2))]),
      );
      expect(results.every((r) => r.kind === 'ack')).to.equal(true);
      const rows = await c.readAll(ids);
      expect(rows).to.have.length(ids.length);
      expect(rows.every((row) => row.entityVersion === 2)).to.equal(true);
    });

    it(`${c.label}: high contention on one company retains the maximum version`, async () => {
      const id = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, i) => deliver(c.make(id, i + 1))),
      );
      expect(results.every((r) => r.kind === 'ack')).to.equal(true);
      expect(await c.read(id)).to.include({ entityVersion: 24 });
    });

    it(`${c.label}: retries the conditional update when v1 commits between v2's missing-row update and insert`, async () => {
      const id = randomUUID();
      let firstUpdateSeen = false;
      let updateCalls = 0;
      let skippedCreate = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let finished = false;
      const transform = (tx: Tx): Tx =>
        new Proxy(tx, {
          get(target, key, receiver) {
            if (key !== c.model) return Reflect.get(target, key, receiver);
            return new Proxy(Reflect.get(target, key), {
              get(delegate, method, delegateReceiver) {
                if (method !== 'updateMany' && method !== 'createMany')
                  return Reflect.get(delegate, method, delegateReceiver);
                return async (args: unknown) => {
                  const result = await Reflect.apply(Reflect.get(delegate, method), delegate, [
                    args,
                  ]);
                  if (method === 'updateMany') {
                    updateCalls++;
                    if (updateCalls === 1) {
                      expect(result.count).to.equal(0);
                      firstUpdateSeen = true;
                      await gate;
                    }
                  } else skippedCreate = result.count === 0;
                  return result;
                };
              },
            });
          },
        });
      const v2 = deliver(c.make(id, 2), transform).then((result) => {
        finished = true;
        return result;
      });
      try {
        await eventually(async () => firstUpdateSeen || finished, 5000);
        expect(firstUpdateSeen).to.equal(true);
        expect(await deliver(c.make(id, 1))).to.deep.equal({ kind: 'ack' });
      } finally {
        release();
      }
      expect(await v2).to.deep.equal({ kind: 'ack' });
      expect(skippedCreate).to.equal(true);
      expect(updateCalls).to.equal(2);
      expect(await c.read(id)).to.include({ entityVersion: 2 });
    });
  }

  it('E05 maps all fields, clears an omitted logo, and applies changed badges/status', async () => {
    const id = randomUUID();
    await deliver(companyStatusEvent(id, 1));
    expect(
      await db.prisma.companySnapshot.findUniqueOrThrow({ where: { companyId: id } }),
    ).to.include({ logoKey: 'companies/logo.png', universityPartner: false, verifiedBadge: true });
    const newer = companyStatusEvent(id, 2, {
      status: 'SUSPENDED',
      snapshot: { name: 'Renamed company', university_partner: true, verified_badge: false },
    });
    await deliver(newer);
    const latest = await db.prisma.companySnapshot.findUniqueOrThrow({ where: { companyId: id } });
    expect(latest).to.include({
      companyId: id,
      name: 'Renamed company',
      logoKey: null,
      status: 'SUSPENDED',
      universityPartner: true,
      verifiedBadge: false,
      entityVersion: 2,
    });
    await deliver(companyStatusEvent(id, 2));
    expect(
      await db.prisma.companySnapshot.findUniqueOrThrow({ where: { companyId: id } }),
    ).to.deep.equal(latest);
  });

  it('E06 toggles both entitlements and E18 activates/deactivates UNDER_REVIEW without stale reversals', async () => {
    const id = randomUUID();
    await deliver(
      companyEntitlementEvent(id, 1, { featured_enabled: false, fast_track_enabled: true }),
    );
    await deliver(
      companyEntitlementEvent(id, 2, { featured_enabled: true, fast_track_enabled: false }),
    );
    await deliver(
      companyEntitlementEvent(id, 1, { featured_enabled: false, fast_track_enabled: true }),
    );
    expect(
      await db.prisma.companyEntitlement.findUniqueOrThrow({ where: { companyId: id } }),
    ).to.include({ featuredEnabled: true, fastTrackEnabled: false, entityVersion: 2 });
    await deliver(companyFlagEvent(id, 1, { active: true }));
    expect(await db.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: id } })).to.include({
      underReview: true,
    });
    await deliver(companyFlagEvent(id, 2, { active: false }));
    await deliver(companyFlagEvent(id, 1, { active: true }));
    await deliver(companyFlagEvent(id, 2, { active: true }));
    expect(await db.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: id } })).to.include({
      underReview: false,
      entityVersion: 2,
    });
  });

  it('keeps the three company version streams independent', async () => {
    const id = randomUUID();
    await deliver(companyStatusEvent(id, 10));
    await deliver(companyEntitlementEvent(id, 2));
    await deliver(companyFlagEvent(id, 1));
    expect(
      await db.prisma.companySnapshot.findUniqueOrThrow({ where: { companyId: id } }),
    ).to.include({ entityVersion: 10 });
    expect(
      await db.prisma.companyEntitlement.findUniqueOrThrow({ where: { companyId: id } }),
    ).to.include({ entityVersion: 2 });
    expect(await db.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: id } })).to.include({
      entityVersion: 1,
    });
  });

  it('E05 company suspension leaves the entire Job row unchanged and emits no events/history', async () => {
    const companyId = randomUUID();
    const job = await db.prisma.job.create({
      data: {
        companyId,
        createdBy: randomUUID(),
        status: 'PUBLISHED',
        version: 1,
        entityVersion: 1,
        category: 'TECH_IT',
        jobTitle: 'Intern',
        description: 'Description',
        responsibilities: 'Work',
        qualifications: 'Student',
        location: 'Bangkok',
        workMode: 'ONSITE',
        hoursPerWeek: 40,
        allowanceType: 'NONE',
        internshipPeriodStart: new Date('2027-01-01'),
        internshipPeriodEnd: new Date('2027-04-01'),
        targetMajors: ['CS'],
        quota: 1,
        applicationDeadline: new Date('2026-12-01'),
      },
    });
    await deliver(companyStatusEvent(companyId, 1, { status: 'SUSPENDED' }));
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
    expect(await db.prisma.statusHistory.count()).to.equal(0);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
  });
});
