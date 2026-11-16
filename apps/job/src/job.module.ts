import { MessagingModule } from '@internpath/common';
import { Module } from '@nestjs/common';
import { ConsumersModule } from './events/consumers/consumers.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import type { Tx } from './prisma/types';

/** Infrastructure-backed Job features; consumes company events only. */
@Module({
  imports: [
    MessagingModule.register<Tx>({
      service: 'job',
      imports: [PrismaModule],
      consumes: {
        inject: [PrismaService],
        useFactory: (prisma: PrismaService) => ({
          runInTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => prisma.$transaction(fn),
        }),
      },
    }),
    ConsumersModule,
  ],
})
export class JobModule {}
