import type { CompanyFlagChangedPayload, EventEnvelope } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompanySnapshotService } from '../../company/company-snapshot.service';
import type { Tx } from '../../prisma/types';

@Injectable()
export class CompanyFlagChangedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly snapshots: CompanySnapshotService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<CompanyFlagChangedPayload>({
      producer: 'verification',
      type: 'CompanyFlagChanged',
      handler: (env, tx) =>
        this.snapshots.handleCompanyFlagChanged(
          env as EventEnvelope<'CompanyFlagChanged', CompanyFlagChangedPayload>,
          tx,
        ),
    });
  }
}
