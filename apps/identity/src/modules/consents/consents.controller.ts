import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { RecordConsentDto } from './consents.dto';
import { ConsentsService } from './consents.service';

@Controller('users/me/consents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class ConsentsController {
  constructor(private readonly service: ConsentsService) {}

  @Post()
  record(@CurrentUser() actor: JwtClaims, @Body() body: RecordConsentDto) { return this.service.record(actor.sub, body); }
}
