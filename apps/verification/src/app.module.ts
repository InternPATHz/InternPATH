import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, createLoggingModule } from '@internpath/common';
import { VerificationModule } from './verification.module';

// DISABLE_INFRA=true (ตั้งใน test/setup.ts) = ไม่โหลดส่วนที่ต้องใช้ DB/RabbitMQ ให้เทสต์พื้นฐาน/CI รันได้โดยไม่มี infra
const infra = process.env.DISABLE_INFRA === 'true' ? [] : [VerificationModule];

@Module({
  imports: [
    // อ่าน .env ของโฟลเดอร์นี้ก่อน แล้วค่อย .env ที่ราก repo
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('verification'),
    HealthModule.register({ service: 'verification', databaseUrlEnv: 'VERIFICATION_DATABASE_URL', requireBroker: true }),
    ...infra,
  ],
})
export class AppModule {}
