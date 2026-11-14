import { Module } from '@nestjs/common';
import { DirectoryController } from './directory.controller';
import { DirectoryRatingService } from './directory-rating.service';
import { DirectoryService } from './directory.service';

@Module({
  controllers: [DirectoryController],
  providers: [DirectoryService, DirectoryRatingService],
  exports: [DirectoryRatingService],
})
export class DirectoryModule {}
