import { Module } from '@nestjs/common';
import { DirectoryController } from './directory.controller';
import { DirectoryJobClient } from './directory-job.client';
import { DirectoryRatingService } from './directory-rating.service';
import { DirectoryService } from './directory.service';

@Module({
  controllers: [DirectoryController],
  providers: [DirectoryService, DirectoryRatingService, DirectoryJobClient],
  exports: [DirectoryRatingService],
})
export class DirectoryModule {}
