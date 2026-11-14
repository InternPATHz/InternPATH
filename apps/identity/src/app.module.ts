import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, MessagingModule, createLoggingModule } from '@internpath/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdvisorLinkModule } from './modules/advisor-links/advisor-link.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { AdminModule } from './modules/admin/admin.module';

const infra = process.env.DISABLE_INFRA === 'true' ? [] : [
  PrismaModule,
  AdvisorLinkModule,
  CompaniesModule,
  AdminModule,
  MessagingModule.register({ service: 'identity', publishes: { databaseUrlEnv: 'IDENTITY_DIRECT_URL' } }),
];

@Module({
  imports: [
    // อ่าน .env ของโฟลเดอร์นี้ก่อน แล้วค่อย .env ที่ราก repo
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('identity'),
    HealthModule.register({ service: 'identity', databaseUrlEnv: 'IDENTITY_DATABASE_URL', requireBroker: true }),
    ...infra,
    ...(process.env.DISABLE_INFRA === 'true' ? [] : [AuthModule]),
    // TODO: ต่อ modules/* ตาม docs/architecture.md §2
  ],
})
export class AppModule {}
