import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims } from '@internpath/common';
import { UpdateMeDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  me(@CurrentUser() actor: JwtClaims) { return this.service.me(actor.sub); }

  @Patch()
  update(@CurrentUser() actor: JwtClaims, @Body() body: UpdateMeDto) { return this.service.update(actor.sub, body); }
}
