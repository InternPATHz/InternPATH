import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, createLoggingModule } from '@internpath/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';

const infra = process.env.DISABLE_INFRA === 'true' ? [] : [PrismaModule];

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
