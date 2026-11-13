import type { CompanyStatusChangedPayload, EventEnvelope } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompanySnapshotService } from '../company/company-snapshot.service';
import type { Tx } from '../prisma/types';

/** รับ E05 `CompanyStatusChanged` จาก Identity เพื่ออัปเดตสำเนาชื่อ/สถานะบริษัท */
@Injectable()
export class CompanyStatusChangedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly snapshots: CompanySnapshotService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<CompanyStatusChangedPayload>({
      producer: 'identity',
      type: 'CompanyStatusChanged',
      handler: (env, tx) =>
        this.snapshots.handleCompanyStatusChanged(env as EventEnvelope<'CompanyStatusChanged', CompanyStatusChangedPayload>, tx),
    });
  }
}
