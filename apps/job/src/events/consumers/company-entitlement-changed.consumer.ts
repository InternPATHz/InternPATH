import type { CompanyEntitlementChangedPayload, EventEnvelope } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompanySnapshotService } from '../../company/company-snapshot.service';
import type { Tx } from '../../prisma/types';

@Injectable()
export class CompanyEntitlementChangedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly snapshots: CompanySnapshotService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<CompanyEntitlementChangedPayload>({
      producer: 'identity',
      type: 'CompanyEntitlementChanged',
      handler: (env, tx) =>
        this.snapshots.handleCompanyEntitlementChanged(
          env as EventEnvelope<'CompanyEntitlementChanged', CompanyEntitlementChangedPayload>,
          tx,
        ),
    });
  }
}
