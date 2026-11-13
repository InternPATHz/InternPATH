import { INestApplication, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createJwtKit, type JwtKit } from './jwt';
import type { TestDatabase } from './db';

/** แทน MessagingModule ในเทสต์ที่ไม่ต้องใช้ Broker: ให้ OutboxWriter (ไม่มี dependency) เท่านั้น */
@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
export class StubMessagingModule {}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  token: JwtKit['token'];
}

/**
 * app ทดสอบ: ConfigModule (JWT_PUBLIC_KEY, ฐานข้อมูลทดสอบ, SLA) + PrismaModule + StubMessagingModule + configureApp
 * `imports` คือโมดูลของฟีเจอร์ที่ต้องการทดสอบ
 */
export async function createTestApp(o: { imports: any[]; db: TestDatabase }): Promise<TestApp> {
  const kit = createJwtKit();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            JWT_PUBLIC_KEY: kit.publicKey,
            VERIFICATION_DATABASE_URL: o.db.url,
            QUEUE_SLA_HOURS_NORMAL: 48,
            QUEUE_SLA_HOURS_FAST: 12,
          }),
        ],
      }),
      PrismaModule,
      StubMessagingModule,
      ...o.imports,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, prisma: moduleRef.get(PrismaService), token: kit.token };
}
