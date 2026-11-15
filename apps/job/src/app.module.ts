import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule, createLoggingModule } from '@internpath/common';
import { JobModule } from './job.module';

// Basic tests omit infrastructure providers; database tests use their disposable client.
const infra = process.env.DISABLE_INFRA === 'true' ? [] : [JobModule];

@Module({
  imports: [
    // อ่าน .env ของโฟลเดอร์นี้ก่อน แล้วค่อย .env ที่ราก repo
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    createLoggingModule('job'),
    HealthModule.register({
      service: 'job',
      databaseUrlEnv: 'JOB_DATABASE_URL',
      requireBroker: true,
    }),
    ...infra,
    // TODO: ต่อ modules/* ตาม docs/architecture.md §2
  ],
})
export class AppModule {}
