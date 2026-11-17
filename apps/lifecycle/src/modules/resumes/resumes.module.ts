import { Module } from '@nestjs/common';
import { AdvisorResumesController, HrResumesController, MyResumesController } from './resumes.controller';
import { ResumesService } from './resumes.service';

@Module({
  controllers: [MyResumesController, HrResumesController, AdvisorResumesController],
  providers: [ResumesService],
  exports: [ResumesService],
})
export class ResumesModule {}
