import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, createLoggingModule } from '@internpath/common';
import { DenylistService } from './denylist/denylist.service';
import { UserSuspendedConsumer } from './events/consumers/user-suspended.consumer';

const eventConsumers = process.env.DISABLE_INFRA === 'true' ? [] : [UserSuspendedConsumer];

@Module({
  imports: [
    // อ่าน .env ของโฟลเดอร์นี้ก่อน แล้วค่อย .env ที่ราก repo
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('gateway'),
    HealthModule.register({ service: 'gateway' }),
  ],
  providers: [DenylistService, ...eventConsumers],
})
export class AppModule {}
