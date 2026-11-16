import { randomUUID } from 'node:crypto';
import type {
  CompanyEntitlementChangedPayload,
  CompanyFlagChangedPayload,
  CompanyStatusChangedPayload,
  EventEnvelope,
  ServiceName,
} from '@internpath/contracts';
import type { EventConsumer, Subscription } from '@internpath/common';
import { CompanySnapshotService } from '../../src/company/company-snapshot.service';
import { CompanyEntitlementChangedConsumer } from '../../src/events/consumers/company-entitlement-changed.consumer';
import { CompanyFlagChangedConsumer } from '../../src/events/consumers/company-flag-changed.consumer';
import { CompanyStatusChangedConsumer } from '../../src/events/consumers/company-status-changed.consumer';
import type { Tx } from '../../src/prisma/types';

function envelope<T extends string, P>(
  type: T,
  payload: P,
  producer: ServiceName,
): EventEnvelope<T, P> {
  return {
    event_id: randomUUID(),
    type,
    payload,
    producer,
    version: 1,
    occurred_at: '2026-11-15T00:00:00.000Z',
    correlation_id: randomUUID(),
  };
}

export function companyStatusEvent(
  companyId: string,
  version = 1,
  overrides: Partial<CompanyStatusChangedPayload> = {},
) {
  return envelope(
    'CompanyStatusChanged',
    {
      company_id: companyId,
      entity_version: version,
      status: 'VERIFIED',
      snapshot: {
        name: `Company v${version}`,
        logo_key: 'companies/logo.png',
        university_partner: false,
        verified_badge: true,
      },
      changed_at: '2026-11-15T00:00:00.000Z',
      ...overrides,
    } satisfies CompanyStatusChangedPayload,
    'identity',
  );
}

export function companyEntitlementEvent(
  companyId: string,
  version = 1,
  overrides: Partial<CompanyEntitlementChangedPayload> = {},
) {
  return envelope(
    'CompanyEntitlementChanged',
    {
      company_id: companyId,
      entity_version: version,
      featured_enabled: version % 2 === 0,
      fast_track_enabled: version % 3 === 0,
      changed_at: '2026-11-15T00:00:00.000Z',
      ...overrides,
    } satisfies CompanyEntitlementChangedPayload,
    'identity',
  );
}

export function companyFlagEvent(
  companyId: string,
  version = 1,
  overrides: Partial<CompanyFlagChangedPayload> = {},
) {
  return envelope(
    'CompanyFlagChanged',
    {
      company_id: companyId,
      entity_version: version,
      flag: 'UNDER_REVIEW',
      active: version % 2 === 1,
      set_by: 'SYSTEM',
      at: '2026-11-15T00:00:00.000Z',
      ...overrides,
    } satisfies CompanyFlagChangedPayload,
    'verification',
  );
}

export type CompanyEvent = ReturnType<
  typeof companyStatusEvent | typeof companyEntitlementEvent | typeof companyFlagEvent
>;

/** Capture the real consumer registrations for DB tests using shared processDelivery. */
export async function companySubscriptions(
  snapshots: CompanySnapshotService,
): Promise<Map<string, Subscription<Tx>>> {
  const subscriptions = new Map<string, Subscription<Tx>>();
  const consumer = {
    subscribe: async <P>(sub: Subscription<Tx, P>) => {
      subscriptions.set(sub.type, sub as Subscription<Tx>);
    },
  } as EventConsumer<Tx>;
  await new CompanyStatusChangedConsumer(consumer, snapshots).onModuleInit();
  await new CompanyEntitlementChangedConsumer(consumer, snapshots).onModuleInit();
  await new CompanyFlagChangedConsumer(consumer, snapshots).onModuleInit();
  return subscriptions;
}
