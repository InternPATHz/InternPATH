import { JwtAuthGuard, MessagingModule } from '@internpath/common';
import { Global, Module } from '@nestjs/common';
import type { Prisma } from '../generated/client';
import { NotificationEvents } from './events/consumers/notification-events';
import { IdentityClient } from './internal/identity-client';
import { NotificationMailService } from './modules/mail/notification-mail.service';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
class PrismaModule {}

@Module({
  imports: [
    PrismaModule,
    MessagingModule.register<Prisma.TransactionClient>({
      service: 'notification',
      imports: [PrismaModule],
      consumes: {
        inject: [PrismaService],
        useFactory: (db: PrismaService) => ({
          runInTransaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
            db.$transaction(fn),
        }),
      },
    }),
  ],
  controllers: [NotificationsController],
  providers: [NotificationEvents, NotificationMailService, IdentityClient, JwtAuthGuard],
})
export class NotificationModule {}
