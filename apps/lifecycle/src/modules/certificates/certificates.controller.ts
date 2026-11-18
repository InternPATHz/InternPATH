import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type {
  CertificateDownloadResponse,
  CertificateItem,
  Paginated,
  PublicCertificateResponse,
} from '@internpath/contracts';
import { PageQueryDto } from '../resumes/resumes.dto';
import { RevokeCertificateDto } from './certificates.dto';
import { CertificatesService } from './certificates.service';
import { PublicCertificateRateLimitGuard } from './public-rate-limit.guard';

/** api-contract §7.3 — HR ออกใบรับรองของใบสมัคร (path อยู่ใต้ `/hr/applications` แต่แยก controller ตามหัวข้อ 1.7) */
@Controller('hr/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrCertificateIssueController {
  constructor(private readonly service: CertificatesService) {}

  @Post(':id/certificate')
  @HttpCode(201)
  issue(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<CertificateItem> {
    return this.service.issue(user, id, cid);
  }
}

/** api-contract §7.3 — HR เพิกถอนใบที่บริษัทตนออก (UAT-23) */
@Controller('hr/certificates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrCertificatesController {
  constructor(private readonly service: CertificatesService) {}

  @Post(':id/actions/revoke')
  @HttpCode(200)
  revoke(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeCertificateDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<CertificateItem> {
    return this.service.revokeByHr(user, id, body.reason, cid);
  }
}

/** api-contract §7.5 — ใบรับรองของนักศึกษา */
@Controller('me/certificates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class MyCertificatesController {
  constructor(private readonly service: CertificatesService) {}

  @Get()
  list(@CurrentUser() user: JwtClaims, @Query() query: PageQueryDto): Promise<Paginated<CertificateItem>> {
    return this.service.listMine(user, query.page, query.page_size);
  }

  @Get(':id/download')
  download(@CurrentUser() user: JwtClaims, @Param('id', ParseUUIDPipe) id: string): Promise<CertificateDownloadResponse> {
    return this.service.download(user, id);
  }
}

/** api-contract §7.7 — Admin เพิกถอนใบใดก็ได้ + `admin_audit_log` */
@Controller('admin/lifecycle/certificates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminCertificatesController {
  constructor(private readonly service: CertificatesService) {}

  @Post(':id/actions/revoke')
  @HttpCode(200)
  revoke(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeCertificateDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<CertificateItem> {
    return this.service.revokeByAdmin(user, id, body.reason, cid);
  }
}

/**
 * api-contract §7.5 — **Public** (ไม่มี `JwtAuthGuard`; Gateway ข้าม JWT ให้ path นี้)
 * Header `X-Robots-Tag: noindex` / `Cache-Control: no-store` + Rate limit ตั้งใน `PublicCertificateRateLimitGuard`
 * (ให้มีทั้งตอน 200 และ 404) • ไม่มี `verify-hash` (PM ตัดออก — api-contract §7.5, §10 ข้อ 1)
 */
@Controller('public/certificates')
@UseGuards(PublicCertificateRateLimitGuard)
export class PublicCertificatesController {
  constructor(private readonly service: CertificatesService) {}

  @Get(':code')
  lookup(@Param('code') code: string): Promise<PublicCertificateResponse> {
    return this.service.publicLookup(code);
  }
}
