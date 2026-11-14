import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, MessagingModule, createLoggingModule } from '@internpath/common';
import { Prisma } from '../generated/client';
import { InternalModule } from './internal/internal.module';
import { AdminModule } from './modules/admin/admin.module';
import { AdvisorLinkModule } from './modules/advisor-links/advisor-link.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { CompanyMembersModule } from './modules/company-members/company-members.module';
import { ConsentsModule } from './modules/consents/consents.module';
import { DirectoryEventsModule } from './modules/directory/directory-events.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

type Tx = Prisma.TransactionClient;
const infra = process.env.DISABLE_INFRA === 'true' ? [] : [
  PrismaModule,
  AuthModule,
  AdvisorLinkModule,
  CompaniesModule,
  AdminModule,
  InternalModule,
  CompanyMembersModule,
  UsersModule,
  ConsentsModule,
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
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('identity'),
    HealthModule.register({ service: 'identity', databaseUrlEnv: 'IDENTITY_DATABASE_URL', requireBroker: true }),
    ...infra,
  ],
})
export class AppModule {}
