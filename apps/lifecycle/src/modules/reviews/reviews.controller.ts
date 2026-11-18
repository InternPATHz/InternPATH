import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { MyReviewItem, Paginated, PublicReviewItem } from '@internpath/contracts';
import { PageQueryDto } from '../resumes/resumes.dto';
import { CreateReviewDto, ReplyReviewDto } from './reviews.dto';
import { type ReviewReplyResponse, ReviewsService } from './reviews.service';

/** api-contract §7.6 — นักศึกษาเขียนรีวิวของการฝึก (path ใต้ `/applications` แต่แยก controller ตามหัวข้อ 1.8) */
@Controller('applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class StudentReviewController {
  constructor(private readonly service: ReviewsService) {}

  @Post(':id/review')
  @HttpCode(201)
  create(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateReviewDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<MyReviewItem> {
    return this.service.create(user, id, body, cid);
  }
}

/** api-contract §7.6 — `GET /me/reviews` */
@Controller('me/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class MyReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get()
  list(@CurrentUser() user: JwtClaims, @Query() query: PageQueryDto): Promise<Paginated<MyReviewItem>> {
    return this.service.listMine(user, query.page, query.page_size);
  }
}

/** api-contract §7.3 — HR ตอบกลับรีวิว 1 ครั้ง */
@Controller('hr/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Post(':id/reply')
  @HttpCode(201)
  reply(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReplyReviewDto,
  ): Promise<ReviewReplyResponse> {
    return this.service.reply(user, id, body.body);
  }
}

/**
 * api-contract §3 "เส้นทางอ่านสาธารณะ" + §7.6 — **Public** (PM ตัดสิน 2026-11-18)
 * - **ห้ามใส่ `JwtAuthGuard`/`RolesGuard`** — Gateway ข้าม JWT ให้ path นี้ ถ้า Service บังคับ ผู้เยี่ยมชมจะได้ 401
 * - Response เหมือนกันทุกผู้เรียก ไม่อ่านตัวตนผู้เรียกเลย (ไม่มี `@CurrentUser`) • `Cache-Control: public, max-age=60`
 * - Rate limit 60 ครั้ง/นาที/IP ทำที่ Gateway (SA) — ไม่ทำใน Lifecycle
 */
@Controller('companies')
export class CompanyReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Get(':companyId/reviews')
  @Header('Cache-Control', 'public, max-age=60')
  list(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query() query: PageQueryDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<Paginated<PublicReviewItem>> {
    return this.service.listForCompany(companyId, query.page, query.page_size, cid);
  }
}
