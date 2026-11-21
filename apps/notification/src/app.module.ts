import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, createLoggingModule } from '@internpath/common';
import { NotificationModule } from './notification.module';

const infra = process.env.DISABLE_INFRA === 'true' ? [] : [NotificationModule];

@Module({
  imports: [
    // อ่าน .env ของโฟลเดอร์นี้ก่อน แล้วค่อย .env ที่ราก repo
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('notification'),
    HealthModule.register({ service: 'notification', databaseUrlEnv: 'NOTIFICATION_DATABASE_URL', requireBroker: true }),
    ...infra,
  ],
})
export class AppModule {}
