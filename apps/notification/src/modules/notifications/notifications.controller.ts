import { AppException, CurrentUser, JwtAuthGuard, JwtClaims, isUuid } from '@internpath/common';
import type { NotificationItem, Paginated, UnreadCountResponse } from '@internpath/contracts';
import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma.service';

class NotificationsQuery {
  @IsOptional() @IsIn(['true', 'false']) unread?: 'true' | 'false';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size?: number;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() user: JwtClaims,
    @Query() query: NotificationsQuery,
  ): Promise<Paginated<NotificationItem>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where = { userId: user.sub, ...(query.unread === 'true' ? { readAt: null } : {}) };
    const [rows, total] = await this.db.$transaction(
      [
        this.db.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.db.notification.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        ...(row.link ? { link: row.link } : {}),
        read: row.readAt !== null,
        created_at: row.createdAt.toISOString(),
      })),
      meta: { page, page_size: pageSize, total },
    };
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: JwtClaims): Promise<UnreadCountResponse> {
    return {
      count: await this.db.notification.count({ where: { userId: user.sub, readAt: null } }),
    };
  }

  @Post(':id/actions/read')
  @HttpCode(204)
  async read(@CurrentUser() user: JwtClaims, @Param('id') id: string): Promise<void> {
    const notFound = new AppException('NOT_FOUND', 'ไม่พบการแจ้งเตือน', 404);
    if (!isUuid(id)) throw notFound;
    const where = { userId: user.sub, id };
    const updated = await this.db.notification.updateMany({
      where: { ...where, readAt: null },
      data: { readAt: new Date() },
    });
    if (
      updated.count === 0 &&
      !(await this.db.notification.findFirst({ where, select: { id: true } }))
    )
      throw notFound;
  }

  @Post('actions/read-all')
  @HttpCode(204)
  async readAll(@CurrentUser() user: JwtClaims): Promise<void> {
    await this.db.notification.updateMany({
      where: { userId: user.sub, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
