import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, createLoggingModule } from '@internpath/common';
import { DenylistService } from './denylist.service';

@Module({
  imports: [
    // อ่าน .env ของโฟลเดอร์นี้ก่อน แล้วค่อย .env ที่ราก repo
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('gateway'),
    HealthModule.register({ service: 'gateway' }),
  ],
  providers: [DenylistService],
})
export class AppModule {}
