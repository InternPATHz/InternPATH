import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, MessagingModule, createLoggingModule } from '@internpath/common';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { Prisma } from '../generated/client';
import { DirectoryModule } from './modules/directory/directory.module';
import { DirectoryEventsModule } from './modules/directory/directory-events.module';

type Tx = Prisma.TransactionClient;
const infra = process.env.DISABLE_INFRA === 'true' ? [] : [
  PrismaModule,
  DirectoryModule,
  DirectoryEventsModule,
  MessagingModule.register<Tx>({
    service: 'identity',
    publishes: { databaseUrlEnv: 'IDENTITY_DIRECT_URL' },
    imports: [PrismaModule],
    consumes: {
      inject: [PrismaService],
      useFactory: (db: PrismaService) => ({
        runInTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.$transaction(fn),
      }),
    },
  }),
];

@Module({
  imports: [
    // อ่าน .env ของโฟลเดอร์นี้ก่อน แล้วค่อย .env ที่ราก repo
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('identity'),
    HealthModule.register({ service: 'identity', databaseUrlEnv: 'IDENTITY_DATABASE_URL', requireBroker: true }),
    ...infra,
    // TODO: ต่อ modules/* ตาม docs/architecture.md §2
  ],
})
export class AppModule {}
