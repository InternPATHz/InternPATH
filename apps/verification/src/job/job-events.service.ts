import type { EventEnvelope, JobStatusChangedPayload } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { RejectionKind } from '@prisma/client';
import { EvaluationService } from '../evaluation/evaluation.service';
import { FlagService } from '../flag/flag.service';
import type { Tx } from '../prisma/types';
import { JobSnapshotService } from './job-snapshot.service';

/** สถานะประกาศที่นับเป็น "ถูกปฏิเสธ/ระงับ/ลบ" ของบริษัท (README 5.1.4) */
const REJECTION_STATUSES: ReadonlySet<string> = new Set<RejectionKind>(['AUTO_REJECTED', 'ADMIN_REJECTED', 'SUSPENDED', 'REMOVED']);

/** จุดรวมของ E03 `JobStatusChanged` ทุกตัวที่ Verification รับ */
@Injectable()
export class JobEventsService {
  constructor(
    private readonly snapshots: JobSnapshotService,
    private readonly flags: FlagService,
    private readonly evaluation: EvaluationService,
  ) {}

  async handleJobStatusChanged(env: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    await this.snapshots.apply(env, tx);
    if (REJECTION_STATUSES.has(p.to_status)) {
      await this.flags.recordRejection(tx, {
        companyId: p.company_id,
        jobId: p.job_id,
        kind: p.to_status as RejectionKind,
        occurredAt: new Date(p.changed_at),
        sourceEventId: env.event_id,
        correlationId: env.correlation_id,
      });
    }
    await this.evaluation.handleJobStatusChanged(env, tx); // VERIFY_TIMEOUT → คิว JOB_REVIEW (สไลซ์ 1)
  }
}
