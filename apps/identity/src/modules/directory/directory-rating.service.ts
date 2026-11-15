import { Injectable } from '@nestjs/common';
import type { ReviewPublishedPayload } from '@internpath/contracts';
import { Prisma } from '../../../generated/client';

@Injectable()
export class DirectoryRatingService {
  async apply(payload: ReviewPublishedPayload, tx: Prisma.TransactionClient): Promise<void> {
    const count = payload.company_review_count;
    const sum = payload.company_rating_sum;
    const version = payload.entity_version;
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(sum) || sum < count || sum > count * 5 ||
      !Number.isSafeInteger(version) || version < 1) {
      throw new Error('Invalid ReviewPublished rating statistics');
    }
    const data = { companyId: payload.company_id, reviewCount: count, ratingSum: sum, entityVersion: version };
    await tx.companyRatingStats.createMany({ data: [data], skipDuplicates: true });
    await tx.companyRatingStats.updateMany({
      where: { companyId: payload.company_id, entityVersion: { lt: version } },
      data: { reviewCount: count, ratingSum: sum, entityVersion: version },
    });
  }
}
