import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID } from 'class-validator';
import { asUuid } from '../common/uuid';
import { Page, PageQuery, skipOf } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/types';

export class AuditQuery extends PageQuery {
  @IsOptional()
  @IsUUID()
  actor?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  target_type?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export interface AuditRow {
  id: string;
  admin_id: string;
  action: string;
  target_type: string;
  target_id: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  correlation_id: string;
  occurred_at: Date;
}

export interface AuditEntry {
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  correlationId?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** บันทึกการกระทำของ Admin ภายใน Transaction เดียวกับการเปลี่ยนข้อมูล (append-only) */
  async record(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        adminId: e.adminId,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        before: (e.before ?? Prisma.DbNull) as Prisma.InputJsonValue,
        after: (e.after ?? Prisma.DbNull) as Prisma.InputJsonValue,
        reason: e.reason ?? null,
        correlationId: asUuid(e.correlationId),
        // เวลาของแอป (ไม่ใช่ DEFAULT now() ของ DB) เพื่อให้ตัวกรองช่วงเวลาสอดคล้องกับนาฬิกาของ Service
        occurredAt: new Date(),
      },
    });
  }

  async list(q: AuditQuery): Promise<Page<AuditRow>> {
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(q.actor ? { adminId: q.actor } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.target_type ? { targetType: q.target_type } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: skipOf(q),
        take: q.page_size,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        admin_id: r.adminId,
        action: r.action,
        target_type: r.targetType,
        target_id: r.targetId,
        before: r.before,
        after: r.after,
        reason: r.reason,
        correlation_id: r.correlationId,
        occurred_at: r.occurredAt,
      })),
      meta: { page: q.page, page_size: q.page_size, total },
    };
  }
}
