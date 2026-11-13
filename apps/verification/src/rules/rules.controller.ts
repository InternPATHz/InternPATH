import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request } from 'express';
import type { Page } from '../common/pagination';
import { CreateTermDto, TermQuery, TestTextDto, UpdateRiskRulesDto, UpdateTermDto } from './dto';
import { RiskRulesView, RulesService, TermRow } from './rules.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get('blacklist')
  list(@Query() q: TermQuery): Promise<Page<TermRow>> {
    return this.rules.listTerms(q);
  }

  @Post('blacklist')
  create(@Body() dto: CreateTermDto, @CurrentUser() user: JwtClaims, @Req() req: Request): Promise<TermRow> {
    return this.rules.createTerm(dto, { sub: user.sub }, getCorrelationId(req));
  }

  /** ต้องอยู่ก่อน `blacklist/:id` ไม่ได้บังคับ (คนละ method) แต่แยกชัดเจน: ทดสอบข้อความ ไม่บันทึกอะไร */
  @Post('blacklist/test')
  @HttpCode(200)
  test(@Body() dto: TestTextDto) {
    return this.rules.testText(dto.text);
  }

  @Patch('blacklist/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTermDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<TermRow> {
    return this.rules.updateTerm(id, dto, { sub: user.sub }, getCorrelationId(req));
  }

  @Delete('blacklist/:id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtClaims, @Req() req: Request): Promise<void> {
    await this.rules.removeTerm(id, { sub: user.sub }, getCorrelationId(req));
  }

  @Get('risk-rules')
  getRules(): Promise<RiskRulesView> {
    return this.rules.getRules();
  }

  @Put('risk-rules')
  updateRules(@Body() dto: UpdateRiskRulesDto, @CurrentUser() user: JwtClaims, @Req() req: Request): Promise<RiskRulesView> {
    return this.rules.updateRules(dto, { sub: user.sub }, getCorrelationId(req));
  }
}
