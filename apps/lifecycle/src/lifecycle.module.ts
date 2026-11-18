import { Module } from '@nestjs/common';
import { JwtAuthGuard, MessagingModule, RolesGuard } from '@internpath/common';
import { LifecycleConfigModule } from './config/lifecycle-config.module';
import { ServiceSecretsCheck } from './config/service-secrets.check';
import { StorageModule } from './common/storage/storage.module';
import { InternalModule } from './internal/internal.module';
import { DeletionEligibilityModule } from './internal/deletion-eligibility.controller';
import { LifecycleConsumersModule } from './events/consumers/lifecycle-consumers.module';
import { AdvisorModule } from './modules/advisor/advisor.module';
import { ReviewConsumersModule } from './events/consumers/review-moderation-result.consumer';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { HrApplicationsModule } from './modules/hr-applications/hr-applications.module';
import { ProblemReportsModule } from './modules/problem-reports/problem-reports.module';
import { AdminLifecycleModule } from './modules/admin/admin-lifecycle.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { ResumesModule } from './modules/resumes/resumes.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { ReservationCheckModule } from './internal/reservation-check.controller';
import { SlaSchedulerModule } from './jobs/sla-scheduler.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { StateMachineModule } from './state-machine/state-machine.module';
import type { Tx } from './prisma/types';

/**
 * โมดูลหลักของ Lifecycle Service (โหลดเมื่อไม่ได้ตั้ง DISABLE_INFRA=true)
 * ลงทะเบียน MessagingModule:
 * - publishes: relay อ่าน outbox_events ผ่าน LIFECYCLE_DIRECT_URL
 * - consumes: จัดการ processed_events และ runInTransaction ด้วย Prisma.$transaction
 * ลงทะเบียน JwtAuthGuard / RolesGuard ของ @internpath/common (ตั้งแต่ 1.3 — controller แรก)
 * controller ใช้ `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)` แล้วตรวจความเป็นเจ้าของเองใน service
 */
@Module({
  imports: [
    PrismaModule,
    LifecycleConfigModule,
    StorageModule,
    InternalModule,
    MessagingModule.register<Tx>({
      service: 'lifecycle',
      publishes: { databaseUrlEnv: 'LIFECYCLE_DIRECT_URL' },
      imports: [PrismaModule],
      consumes: {
        inject: [PrismaService],
        useFactory: (prisma: PrismaService) => ({
          runInTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => prisma.$transaction(fn),
        }),
      },
    }),
    StateMachineModule,
    SlaSchedulerModule,
    ReservationCheckModule,
    ProfilesModule,
    ResumesModule,
    ApplicationsModule,
    HrApplicationsModule,
    AdminLifecycleModule,
    ProblemReportsModule,
    AdvisorModule,
    ReviewsModule,
    ReviewConsumersModule,
    CertificatesModule,
    LifecycleConsumersModule,
    DeletionEligibilityModule,
  ],
  providers: [JwtAuthGuard, RolesGuard, ServiceSecretsCheck],
  exports: [
    PrismaModule,
    LifecycleConfigModule,
    StorageModule,
    InternalModule,
    StateMachineModule,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class LifecycleModule {}
