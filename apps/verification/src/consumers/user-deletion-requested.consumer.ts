import type { EventEnvelope, UserDeletionRequestedPayload } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { UserAnonymizationService } from '../anonymization/user-anonymization.service';
import type { Tx } from '../prisma/types';

/** รับ E15 `UserDeletionRequested` จาก Identity เพื่อทำให้ข้อมูลของผู้ใช้ไม่ระบุตัวตน (ไม่ต้องตอบกลับ — event-contract §E15) */
@Injectable()
export class UserDeletionRequestedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly anonymization: UserAnonymizationService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<UserDeletionRequestedPayload>({
      producer: 'identity',
      type: 'UserDeletionRequested',
      handler: (env, tx) =>
        this.anonymization.handleUserDeletionRequested(env as EventEnvelope<'UserDeletionRequested', UserDeletionRequestedPayload>, tx),
    });
  }
}
