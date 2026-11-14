import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventConsumer } from '@internpath/common';
import type { ReviewPublishedPayload } from '@internpath/contracts';
import { Prisma } from '../../../generated/client';
import { DirectoryRatingService } from './directory-rating.service';

@Injectable()
export class ReviewPublishedConsumer implements OnModuleInit {
  constructor(private readonly consumer: EventConsumer<Prisma.TransactionClient>,
    private readonly ratings: DirectoryRatingService) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<ReviewPublishedPayload>({
      producer: 'lifecycle', type: 'ReviewPublished',
      handler: (event, tx) => this.ratings.apply(event.payload, tx),
    });
  }
}
