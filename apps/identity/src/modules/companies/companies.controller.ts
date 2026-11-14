import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { CompanyActionDto, CompanyQueryDto, UpdateCompanyDto, UploadDocumentDto } from './companies.dto';
import { CompaniesService } from './companies.service';

@Controller('companies/me')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class CompaniesController {
  constructor(private readonly service: CompaniesService) {}

  @Get()
  me(@CurrentUser() actor: JwtClaims) { return this.service.me(actor.sub); }

  @Patch()
  update(@CurrentUser() actor: JwtClaims, @Body() body: UpdateCompanyDto, @Headers('x-correlation-id') cid: string) {
    return this.service.update(actor.sub, body, cid);
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  logo(@CurrentUser() actor: JwtClaims, @UploadedFile() file: Express.Multer.File, @Headers('x-correlation-id') cid: string) {
    return this.service.logo(actor.sub, file, cid);
  }

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  document(@CurrentUser() actor: JwtClaims, @Body() body: UploadDocumentDto, @UploadedFile() file: Express.Multer.File) {
    return this.service.document(actor.sub, body.doc_type, file);
  }

  @Get('documents')
  documents(@CurrentUser() actor: JwtClaims) { return this.service.documents(actor.sub); }

  @Post('resubmit') @HttpCode(204)
  resubmit(@CurrentUser() actor: JwtClaims, @Headers('x-correlation-id') cid: string) { return this.service.resubmit(actor.sub, cid); }
}

@Controller('admin/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminCompaniesController {
  constructor(private readonly service: CompaniesService) {}

  @Get()
  list(@CurrentUser() actor: JwtClaims, @Query() query: CompanyQueryDto) { return this.service.adminList(actor.sub, query); }

  @Get(':id')
  detail(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) id: string) { return this.service.adminDetail(actor.sub, id); }

  @Post(':id/actions/:action') @HttpCode(204)
  action(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) id: string, @Param('action') action: string,
    @Body() body: CompanyActionDto, @Headers('x-correlation-id') cid: string) {
    return this.service.adminAction(actor.sub, id, action, body.reason, cid);
  }
}
