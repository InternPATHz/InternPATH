import { Module } from '@nestjs/common';
import { AdminAdvisorsController, AdvisorRequestsController, AdvisorsController, IdentityMeController } from './advisor-link.controller';
import { AdvisorLinkService } from './advisor-link.service';

@Module({ controllers: [IdentityMeController, AdvisorsController, AdvisorRequestsController, AdminAdvisorsController], providers: [AdvisorLinkService] })
export class AdvisorLinkModule {}
