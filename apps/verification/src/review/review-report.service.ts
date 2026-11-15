import { AppException, JwtClaims } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/client';
import { lockScope } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { ReviewReportDto } from './dto';

/** รีวิวที่เผยแพร่อยู่ = ผ่านการสแกน หรือ Admin ยืนยันให้คงอยู่ */
const REPORTABLE_STATUSES: ReadonlySet<string> = new Set(['PASSED', 'ADMIN_PUBLISHED']);

@Injectable()
export class ReviewReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /**
   * POST /reviews/{review_id}/reports (สไลซ์ 3 §5.4) ลำดับตรวจ: 404 → 403 (HR คนละบริษัท) → 422 → 409 → บันทึก
   * ล็อก review ก่อน (ร่วมกับ action ของ Admin) เพื่อไม่ให้รายงานรีวิวที่กำลังถูกลบพร้อมกัน
   * ห้าม log reason
   */
  async report(reviewId: string, dto: ReviewReportDto, user: JwtClaims, correlationId?: string): Promise<{ id: string; status: 'OPEN' }> {
    return this.prisma.$transaction(async (tx) => {
      await lockScope(tx, 'review', reviewId);
      const review = await tx.reviewModeration.findUnique({ where: { reviewId }, select: { companyId: true, status: true } });
      if (!review) throw new AppException('NOT_FOUND', 'ไม่พบรีวิว', 404);
      if (user.role === 'COMPANY_HR' && (!user.company_id || user.company_id !== review.companyId)) {
        throw new AppException('FORBIDDEN_ROLE', 'รายงานได้เฉพาะรีวิวของบริษัทตนเอง', 403);
      }
      if (!REPORTABLE_STATUSES.has(review.status)) {
        throw new AppException('REVIEW_NOT_REPORTABLE', 'รีวิวนี้ไม่อยู่ในสถานะที่รายงานได้', 422);
      }

      let report;
      try {
        report = await tx.reviewReport.create({ data: { reviewId, reporterUserId: user.sub, reason: dto.reason } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new AppException('ALREADY_REPORTED', 'คุณรายงานรีวิวนี้ไปแล้ว', 409);
        }
        throw e;
      }

      // รายการเปิดของรีวิวนี้มีแล้ว ⇒ null (ไม่ใช่ error)
      await this.queue.createReviewItem(tx, { type: 'REVIEW_REPORT', reviewId, companyId: review.companyId, origin: 'REVIEW_REPORT', correlationId });
      return { id: report.id, status: 'OPEN' as const };
    });
  }
}
