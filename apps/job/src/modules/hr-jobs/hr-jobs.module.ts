import { JwtAuthGuard, RolesGuard } from '@internpath/common';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StatusModule } from '../../status/status.module';
import { HrJobsController } from './hr-jobs.controller';
import { HrJobsService } from './hr-jobs.service';

@Module({
  imports: [PrismaModule, StatusModule],
  controllers: [HrJobsController],
  providers: [HrJobsService, JwtAuthGuard, RolesGuard],
})
export class HrJobsModule {}
