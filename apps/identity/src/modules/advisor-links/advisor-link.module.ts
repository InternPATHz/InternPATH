import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminAdvisorsController, AdvisorStudentsController } from './advisor-link.controller';
import { AdvisorLinkService } from './advisor-link.service';

@Module({ imports: [AuthModule], controllers: [AdvisorStudentsController, AdminAdvisorsController], providers: [AdvisorLinkService] })
export class AdvisorLinkModule {}
