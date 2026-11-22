import { JwtAuthGuard, RolesGuard } from '@internpath/common';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminJobsController } from './admin-jobs.controller';
import { AdminJobsService } from './admin-jobs.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminJobsController],
  providers: [AdminJobsService, JwtAuthGuard, RolesGuard],
})
export class AdminJobsModule {}
