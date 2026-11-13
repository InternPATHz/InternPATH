import { Module } from '@nestjs/common';
import { MessagingModule } from '@internpath/common';
import { AppealModule } from './appeal/appeal.module';
import { AuditModule } from './audit/audit.module';
import { ConsumersModule } from './consumers/consumers.module';
import { EvaluationModule } from './evaluation/evaluation.module';
import { FlagModule } from './flag/flag.module';
import { JobModule } from './job/job.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import type { Tx } from './prisma/types';
import { ReportModule } from './report/report.module';
import { RulesModule } from './rules/rules.module';

/**
 * โมดูลรวมของ Service (โหลดเมื่อไม่ได้ตั้ง DISABLE_INFRA=true) — ฟีเจอร์ที่ตามมาใน Task 5-10 เพิ่มใน imports
 * MessagingModule: relay อ่าน outbox จาก VERIFICATION_DIRECT_URL; consumer ใช้ `$transaction` ของ Prisma
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    RulesModule,
    EvaluationModule,
    AppealModule,
    FlagModule,
    JobModule,
    ReportModule,
    ConsumersModule,
    MessagingModule.register<Tx>({
      service: 'verification',
      publishes: { databaseUrlEnv: 'VERIFICATION_DIRECT_URL' },
      imports: [PrismaModule],
      consumes: {
        inject: [PrismaService],
        useFactory: (prisma: PrismaService) => ({
          runInTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => prisma.$transaction(fn),
        }),
      },
    }),
  ],
})
export class VerificationModule {}
