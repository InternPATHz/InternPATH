import { Injectable } from '@nestjs/common';
import { AppException } from '@internpath/common';
import type { Prisma, QueueItem } from '@prisma/client';
import { Page, skipOf } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { MatchedKeyword } from '../screening/types';
import { QueueQuery } from './dto';
import { Highlight, buildHighlights } from './highlights';
import { isOverdue } from './sla';

export interface QueueListItem {
  id: string;
  type: string;
  target_id: string;
  company_id: string | null;
  company_name: string | null;
  priority: string;
  risk_level: string | null;
  is_appeal: boolean;
  due_at: Date;
  overdue: boolean;
  status: string;
  created_at: Date;
}

export interface QueueDetail extends QueueListItem {
  submission_id: string | null;
  origin: string;
  assigned_to: string | null;
  resolution: string | null;
  resolved_at: Date | null;
  risk_score: number | null;
  reasons: unknown;
  content: unknown;
  highlights: Highlight[];
  appeal_statement: string | null;
  /** เฉพาะ JOB_REPORT: รายงานทั้งหมดของประกาศ (ตัวตนผู้รายงานเห็นได้เฉพาะ Admin ผ่าน endpoint นี้) — ชนิดอื่นเป็น [] */
  reports: ReportView[];
}

export interface ReportView {
  id: string;
  reporter_user_id: string;
  category: string;
  detail: string;
  counted: boolean;
  status: string;
  created_at: Date;
}

@Injectable()
export class QueueQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: QueueQuery, now = new Date()): Promise<Page<QueueListItem>> {
    const and: Prisma.QueueItemWhereInput[] = [];
    if (q.type) and.push({ type: q.type });
    if (q.priority) and.push({ priority: q.priority });
    if (q.risk_level) and.push({ riskLevel: q.risk_level });
    if (q.status) and.push({ status: q.status });
    if (q.overdue) and.push({ status: { not: 'RESOLVED' }, dueAt: { lt: now } });
    const where: Prisma.QueueItemWhereInput = and.length ? { AND: and } : {};

    const [rows, total] = await Promise.all([
      this.prisma.queueItem.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }], // FAST_TRACK ก่อน (ประกาศ enum หลัง NORMAL) แล้วใกล้ครบกำหนดก่อน
        skip: skipOf(q),
        take: q.page_size,
      }),
      this.prisma.queueItem.count({ where }),
    ]);
    const names = await this.companyNames(rows.map((r) => r.companyId));
    return { data: rows.map((r) => this.toListItem(r, names, now)), meta: { page: q.page, page_size: q.page_size, total } };
  }

  async detail(id: string, now = new Date()): Promise<QueueDetail> {
    const item = await this.prisma.queueItem.findUnique({ where: { id } });
    if (!item) throw new AppException('NOT_FOUND', 'ไม่พบรายการคิว', 404);
    const [evaluation, appeal, names, reportRows] = await Promise.all([
      item.submissionId ? this.prisma.evaluation.findUnique({ where: { submissionId: item.submissionId } }) : null,
      item.type === 'JOB_APPEAL' ? this.prisma.appeal.findUnique({ where: { jobId: item.targetId } }) : null,
      this.companyNames([item.companyId]),
      item.type === 'JOB_REPORT' ? this.prisma.jobReport.findMany({ where: { jobId: item.targetId }, orderBy: { createdAt: 'asc' } }) : [],
    ]);
    return {
      ...this.toListItem(item, names, now),
      submission_id: item.submissionId,
      origin: item.origin,
      assigned_to: item.assignedTo,
      resolution: item.resolution,
      resolved_at: item.resolvedAt,
      risk_score: evaluation?.riskScore ?? null,
      reasons: evaluation?.reasons ?? [],
      content: evaluation?.content ?? null,
      highlights: buildHighlights((evaluation?.matchedKeywords ?? []) as unknown as MatchedKeyword[]),
      appeal_statement: appeal?.statement ?? null,
      reports: reportRows.map((r) => ({
        id: r.id,
        reporter_user_id: r.reporterUserId,
        category: r.category,
        detail: r.detail,
        counted: r.counted,
        status: r.status,
        created_at: r.createdAt,
      })),
    };
  }

  private async companyNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.companySnapshot.findMany({ where: { companyId: { in: unique } } });
    return new Map(rows.map((r) => [r.companyId, r.name]));
  }

  private toListItem(r: QueueItem, names: Map<string, string>, now: Date): QueueListItem {
    return {
      id: r.id,
      type: r.type,
      target_id: r.targetId,
      company_id: r.companyId,
      company_name: r.companyId ? (names.get(r.companyId) ?? null) : null,
      priority: r.priority,
      risk_level: r.riskLevel,
      is_appeal: r.isAppeal,
      due_at: r.dueAt,
      overdue: isOverdue(r, now),
      status: r.status,
      created_at: r.createdAt,
    };
  }
}
