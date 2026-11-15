import { Module } from '@nestjs/common';
import { DirectoryModule } from '../../modules/directory/directory.module';
import { ReviewPublishedConsumer } from './review-published.consumer';

@Module({ imports: [DirectoryModule], providers: [ReviewPublishedConsumer] })
export class DirectoryEventsModule {}
