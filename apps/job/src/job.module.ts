import { MessagingModule } from '@internpath/common';
import { Module } from '@nestjs/common';
import { ConsumersModule } from './events/consumers/consumers.module';
import { HrJobsModule } from './modules/hr-jobs/hr-jobs.module';
import { InternalJobsModule } from './modules/internal-jobs/internal-jobs.module';
import { PublicJobsModule } from './modules/public-jobs/public-jobs.module';
import { TagsModule } from './modules/tags/tags.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import type { Tx } from './prisma/types';

/** One messaging registration owns Job consumption and its transactional outbox relay. */
@Module({
  imports: [
    MessagingModule.register<Tx>({
      service: 'job',
      publishes: { databaseUrlEnv: 'JOB_DIRECT_URL' },
      imports: [PrismaModule],
      consumes: {
        inject: [PrismaService],
        useFactory: (prisma: PrismaService) => ({
          runInTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => prisma.$transaction(fn),
        }),
      },
    }),
    ConsumersModule,
    PublicJobsModule,
    TagsModule,
    HrJobsModule,
    InternalJobsModule,
  ],
})
export class JobModule {}
