import { Module } from '@nestjs/common';
import { StateMachineModule } from '../../state-machine/state-machine.module';
import { CertificatePdfRenderer, PlaywrightCertificatePdfRenderer } from './certificate-pdf.renderer';
import {
  AdminCertificatesController,
  HrCertificateIssueController,
  HrCertificatesController,
  MyCertificatesController,
  PublicCertificatesController,
} from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { PublicCertificateRateLimitGuard } from './public-rate-limit.guard';

/**
 * E-Certificate (หัวข้อ 1.7) — `S3StorageService` มาจาก StorageModule (Global), `OutboxWriter` จาก MessagingModule (Global)
 * `StateMachineModule` ให้ `StatusHistoryWriter`
 */
@Module({
  imports: [StateMachineModule],
  controllers: [
    HrCertificateIssueController,
    HrCertificatesController,
    MyCertificatesController,
    AdminCertificatesController,
    PublicCertificatesController,
  ],
  providers: [
    CertificatesService,
    PublicCertificateRateLimitGuard,
    { provide: CertificatePdfRenderer, useClass: PlaywrightCertificatePdfRenderer },
  ],
  exports: [CertificatesService],
})
export class CertificatesModule {}
