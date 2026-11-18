import { EventConsumer } from '@internpath/common';
import type { EventEnvelope, UserDeletionRequestedPayload } from '@internpath/contracts';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Tx } from '../../prisma/types';

const UTC_TIMESTAMP = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isEventTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime()) &&
    timestamp.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

@Injectable()
export class UserDeletionRequestedConsumer implements OnModuleInit {
  private readonly log = new Logger(UserDeletionRequestedConsumer.name);

  constructor(private readonly consumer: EventConsumer<Tx>) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<UserDeletionRequestedPayload>({
      producer: 'identity',
      type: 'UserDeletionRequested',
      supportedVersions: [1],
      handler: (env, tx) => this.anonymize(env, tx),
    });
  }

  private async anonymize(env: EventEnvelope<string, UserDeletionRequestedPayload>, tx: Tx) {
    const p = env.payload;
    if (
      env.producer !== 'identity' ||
      !p ||
      p.mode !== 'DELETE_AND_ANONYMIZE' ||
      !isUUID(p.user_id) ||
      !isUUID(p.anonymous_actor_id) ||
      p.user_id.toLowerCase() === p.anonymous_actor_id.toLowerCase() ||
      typeof p.role !== 'string' ||
      p.role.trim() === '' ||
      (p.company_id !== undefined && !isUUID(p.company_id)) ||
      !isEventTimestamp(p.requested_at)
    ) {
      throw new Error('Invalid UserDeletionRequested payload');
    }

    const { user_id: userId, anonymous_actor_id: anonymousActorId } = p;
    await tx.$queryRaw`
      SELECT set_config('internpath.anonymize', 'on', true) AS anonymize,
             set_config('internpath.anonymous_actor_id', ${anonymousActorId}, true) AS actor
    `;
    const history = await tx.statusHistory.updateMany({
      where: { actorId: userId },
      data: { actorId: anonymousActorId },
    });
    // Update precisely the identifiers. Prisma @updatedAt would also change the record timestamps.
    const jobs = await tx.$executeRaw`
      UPDATE jobs SET created_by = ${anonymousActorId}::uuid WHERE created_by = ${userId}::uuid
    `;
    const submissions = await tx.$executeRaw`
      UPDATE job_submissions SET submitted_by = ${anonymousActorId}::uuid
      WHERE submitted_by = ${userId}::uuid
    `;
    this.log.log(
      `Prepared Job E15 anonymization in the event transaction (history=${history.count}, jobs=${jobs}, submissions=${submissions})`,
    );
  }
}
