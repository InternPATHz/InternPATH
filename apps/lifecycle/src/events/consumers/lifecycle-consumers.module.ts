import { EventConsumer } from '@internpath/common';
import type {
  AdvisorLinkChangedPayload,
  CompanyStatusChangedPayload,
  EventEnvelope,
  JobStatusChangedPayload,
  UserDeletionRequestedPayload,
} from '@internpath/contracts';
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '../../prisma/types';
import { StateMachineModule } from '../../state-machine/state-machine.module';
import { AdvisorLinkChangedHandler } from '../handlers/advisor-link-changed.handler';
import { CompanyStatusChangedHandler } from '../handlers/company-status-changed.handler';
import { JobStatusChangedHandler } from '../handlers/job-status-changed.handler';
import { UserDeletionHandler } from '../handlers/user-deletion.handler';

/**
 * handler ของ E03/E05/E07/E15 — แยกจากการ subscribe เพื่อให้เทสต์เรียก `handle(env, tx)` ตรงได้โดยไม่ต้องมี RabbitMQ
 * `S3StorageService` มาจาก StorageModule (Global), `OutboxWriter` จาก MessagingModule (Global)
 */
@Module({
  imports: [StateMachineModule],
  providers: [JobStatusChangedHandler, CompanyStatusChangedHandler, AdvisorLinkChangedHandler, UserDeletionHandler],
  exports: [JobStatusChangedHandler, CompanyStatusChangedHandler, AdvisorLinkChangedHandler, UserDeletionHandler],
})
export class LifecycleEventHandlersModule {}

/**
 * สมัครรับ Event (หัวข้อ 1.11) — กันซ้ำด้วย `event_id` (`processed_events`), Retry 3 ครั้ง → DLQ,
 * `InvalidMessageError` ⇒ dead-letter ทันที: ทำโดย `EventConsumer` ของ libs/common • handler ใช้ `tx` เดียวกับ processed_events
 */
@Injectable()
export class LifecycleEventSubscriptions implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly jobs: JobStatusChangedHandler,
    private readonly companies: CompanyStatusChangedHandler,
    private readonly advisorLinks: AdvisorLinkChangedHandler,
    private readonly deletions: UserDeletionHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe<JobStatusChangedPayload>({
      producer: 'job',
      type: 'JobStatusChanged',
      handler: async (env, tx) => {
        await this.jobs.handle(env as EventEnvelope<string, JobStatusChangedPayload>, tx);
      },
    });
    await this.consumer.subscribe<CompanyStatusChangedPayload>({
      producer: 'identity',
      type: 'CompanyStatusChanged',
      handler: async (env, tx) => {
        await this.companies.handle(env as EventEnvelope<string, CompanyStatusChangedPayload>, tx);
      },
    });
    await this.consumer.subscribe<AdvisorLinkChangedPayload>({
      producer: 'identity',
      type: 'AdvisorLinkChanged',
      handler: async (env, tx) => {
        await this.advisorLinks.handle(env as EventEnvelope<string, AdvisorLinkChangedPayload>, tx);
      },
    });
    await this.consumer.subscribe<UserDeletionRequestedPayload>({
      producer: 'identity',
      type: 'UserDeletionRequested',
      handler: async (env, tx) => {
        await this.deletions.handle(env as EventEnvelope<string, UserDeletionRequestedPayload>, tx);
      },
    });
  }
}

/** โหลดเฉพาะในแอปจริง (มี MessagingModule.consumes) */
@Module({
  imports: [LifecycleEventHandlersModule],
  providers: [LifecycleEventSubscriptions],
})
export class LifecycleConsumersModule {}
