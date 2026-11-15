import { Module } from '@nestjs/common';
import { AdminOwnerController, CompanyMembersController, InvitationController } from './company-members.controller';
import { CompanyMembersService } from './company-members.service';
import { InvitationMailer } from './invitation-mailer';

@Module({ controllers: [CompanyMembersController, InvitationController, AdminOwnerController],
  providers: [CompanyMembersService, InvitationMailer] })
export class CompanyMembersModule {}
