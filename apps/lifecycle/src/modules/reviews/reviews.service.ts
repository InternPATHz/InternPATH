import { randomUUID } from 'node:crypto';
import { AppException, OutboxWriter, asUuid, type JwtClaims } from '@internpath/common';
import type { MyReviewItem, Paginated, PublicReviewItem, ReplyReviewResponse } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Review, ReviewReply } from '../../../generated/client';
import { assertCompanyOwnership } from '../../common/auth/ownership';
import { REVIEW_SUBMITTED, buildReviewSubmitted } from '../../events/producers/review-events';
import { IdentityInternalClient } from '../../internal/identity-client.service';
import { StudentNamesService } from '../../internal/student-names.service';
import { PrismaService } from '../../prisma/prisma.service';
import { applicationNotFound, evaluationNotOpen } from '../../state-machine/errors';
import { StatusHistoryWriter } from '../../state-machine/status-history.writer';
import { REVIEWABLE_STATUSES, outcomeLabel } from './review-rules';
import type { CreateReviewDto } from './reviews.dto';

const reviewNotFound = (): AppException => new AppException('NOT_FOUND', 'ไม่พบรีวิว', 404);

/**
 * รีวิวบริษัท (api-contract §7.6, README §5.5, data-schema §6)
 * - เก็บ `SUBMITTED` + ส่ง E09 ให้ Verification สแกน — เผยแพร่/พัก/ลบตาม E10 (`ReviewModerationService`)
 * - 1 รีวิวต่อ 1 การฝึก (`reviews.application_id` unique)
 * - ไม่ระบุชื่อ ⇒ แสดง `display_major`/`display_year` ที่เก็บไว้ตอนเขียน; ชื่อจริงดึงสดจาก Identity ตอนแสดง (ห้ามเก็บ)
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly db: PrismaService,
    private readonly identity: IdentityInternalClient,
    private readonly names: StudentNamesService,
    private readonly outbox: OutboxWriter,
    private readonly history: StatusHistoryWriter,
  ) {}

  /**
   * `POST /applications/{id}/review` → `201` (`status: 'SUBMITTED'` + ข้อมูลรีวิว — superset ของ `CreateReviewResponse`)
   * ใบของคนอื่น/ไม่มี ⇒ 404 (ฝั่งนักศึกษาไม่บอกว่ามีอยู่) • ยังไม่ประเมิน/ยังไม่สิ้นสุด ⇒ `422 EVALUATION_NOT_OPEN` + `REVIEW_NOT_OPEN`
   * เขียนแล้ว ⇒ `409 ALREADY_REVIEWED` • `status_history` (REVIEW null→SUBMITTED) + E09 ใน Transaction เดียว
   */
  async create(
    user: JwtClaims,
    applicationId: string,
    body: CreateReviewDto,
    correlationId?: string,
    now = new Date(),
  ): Promise<MyReviewItem> {
    const cid = asUuid(correlationId ?? randomUUID());
    const app = await this.db.application.findUnique({ where: { id: applicationId } });
    if (!app || app.studentUserId !== user.sub) throw applicationNotFound();
    if (!REVIEWABLE_STATUSES.includes(app.status)) throw evaluationNotOpen('REVIEW_NOT_OPEN');
    if (await this.db.review.findUnique({ where: { applicationId: app.id }, select: { id: true } })) {
      throw alreadyReviewed();
    }

    const last = await this.db.evaluation.findFirst({
      where: { applicationId: app.id },
      orderBy: [{ round: 'desc' }, { evaluatedAt: 'desc' }],
      select: { result: true },
    });
    const label = outcomeLabel(app, last?.result);
    if (!label) throw evaluationNotOpen('EVALUATION_MISSING');
    const display = await this.displayProfile(app.studentUserId, cid);

    try {
      const review = await this.db.$transaction(async (tx) => {
        const created = await tx.review.create({
          data: {
            applicationId: app.id,
            companyId: app.companyId,
            studentUserId: app.studentUserId,
            rating: body.rating,
            title: body.title ?? null,
            body: body.body,
            anonymous: body.anonymous,
            displayMajor: display.major,
            displayYear: display.yearLevel,
            outcomeLabel: label,
            status: 'SUBMITTED',
            createdAt: now,
          },
        });
        await this.history.record(tx, {
          entity: 'REVIEW',
          entityId: created.id,
          fromStatus: null,
          toStatus: 'SUBMITTED',
          actor: { userId: user.sub, role: 'STUDENT' },
          correlationId: cid,
          occurredAt: now,
        });
        await this.outbox.add(tx, {
          type: REVIEW_SUBMITTED,
          aggregateId: created.id,
          correlationId: cid,
          payload: buildReviewSubmitted(created),
        });
        return created;
      });
      return toMyReviewItem(review);
    } catch (error) {
      // กดส่งพร้อมกัน ⇒ unique `application_id` ผู้ชนะ 1 ราย
      if ((error as { code?: unknown })?.code === 'P2002') throw alreadyReviewed();
      throw error;
    }
  }

  /** `GET /me/reviews` — ของตนทุกสถานะ (รวม `HELD`/`REMOVED` เพื่อให้รู้ผล) ใหม่สุดก่อน */
  async listMine(user: JwtClaims, page = 1, pageSize = 20): Promise<Paginated<MyReviewItem>> {
    const where = { studentUserId: user.sub };
    const [rows, total] = await Promise.all([
      this.db.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.db.review.count({ where }),
    ]);
    return { data: rows.map(toMyReviewItem), meta: { page, page_size: pageSize, total } };
  }

  /**
   * `POST /hr/reviews/{id}/reply` — ตอบได้ 1 ครั้ง/รีวิว (`409 ALREADY_REPLIED`) เฉพาะรีวิวของบริษัทตน (`403`)
   * ตอบได้เฉพาะรีวิวที่ `PUBLISHED` — สถานะอื่น HR มองไม่เห็นอยู่แล้ว ⇒ 404 (ไม่บอกว่ามีรีวิวรอตรวจ)
   */
  async reply(user: JwtClaims, reviewId: string, body: string, now = new Date()): Promise<ReplyReviewResponse> {
    const review = await this.db.review.findUnique({ where: { id: reviewId } });
    if (!review) throw reviewNotFound();
    assertCompanyOwnership(user, review.companyId);
    if (review.status !== 'PUBLISHED') throw reviewNotFound();
    try {
      const reply = await this.db.reviewReply.create({
        data: { reviewId: review.id, companyId: review.companyId, repliedBy: user.sub, body, createdAt: now },
      });
      return { review_id: review.id, body: reply.body, created_at: reply.createdAt.toISOString() };
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new AppException('ALREADY_REPLIED', 'ตอบกลับรีวิวนี้แล้ว', 409);
      }
      throw error;
    }
  }

  /**
   * `GET /companies/{company_id}/reviews` — เฉพาะ `PUBLISHED` ใหม่สุดก่อน พร้อม `outcome_label` และคำตอบของบริษัท
   * **Public** (api-contract §3, §7.6) ⇒ Response ต้องไม่มี `student_user_id`/`application_id` หรือ id ที่ย้อนหาตัวตน และไม่ขึ้นกับผู้เรียก
   * - ไม่ระบุชื่อ ⇒ `display_major` + `display_year` เท่านั้น
   * - ระบุชื่อ ⇒ `reviewer_name` ดึงสดจาก Identity (Batch); อ่านไม่ได้/บัญชีถูกลบ ⇒ แสดงแบบไม่ระบุชื่อแทน
   */
  async listForCompany(companyId: string, page = 1, pageSize = 20, correlationId?: string): Promise<Paginated<PublicReviewItem>> {
    const where = { companyId, status: 'PUBLISHED' as const };
    const [rows, total] = await Promise.all([
      this.db.review.findMany({
        where,
        include: { reply: true },
        orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.review.count({ where }),
    ]);
    const named = rows.filter((r) => !r.anonymous).map((r) => r.studentUserId);
    const names = named.length ? await this.names.names(named, correlationId) : new Map<string, string>();
    return {
      data: rows.map((row) => toPublicReviewItem(row, names.get(row.studentUserId) || undefined)),
      meta: { page, page_size: pageSize, total },
    };
  }

  /**
   * สาขา/ชั้นปีที่แสดงแทนชื่อ — เก็บตอนเขียนรีวิว (data-schema §6) จากโปรไฟล์ของ Lifecycle ถ้ามี ไม่งั้นจาก Identity
   * Identity ล่มและไม่มีโปรไฟล์ ⇒ throw ต่อ (`502`) — รีวิวไม่ระบุชื่อต้องมีค่าเหล่านี้
   */
  private async displayProfile(studentUserId: string, correlationId: string): Promise<{ major: string; yearLevel: number }> {
    const local = await this.db.studentProfile.findUnique({
      where: { userId: studentUserId },
      select: { major: true, yearLevel: true },
    });
    if (local) return local;
    const student = await this.identity.getStudent(studentUserId, correlationId);
    return { major: student.major, yearLevel: student.year_level };
  }
}

const alreadyReviewed = (): AppException => new AppException('ALREADY_REVIEWED', 'เขียนรีวิวการฝึกงานนี้แล้ว', 409);

export function toMyReviewItem(row: Review): MyReviewItem {
  return {
    id: row.id,
    application_id: row.applicationId,
    company_id: row.companyId,
    rating: row.rating,
    ...(row.title ? { title: row.title } : {}),
    body: row.body,
    anonymous: row.anonymous,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}

/** ส่งออกเฉพาะฟิลด์ใน `PublicReviewItem` — ห้ามเพิ่ม id ของนักศึกษา/ใบสมัคร/ผู้ตอบ (จะเป็น Public) */
export function toPublicReviewItem(row: Review & { reply: ReviewReply | null }, reviewerName?: string): PublicReviewItem {
  const showName = !row.anonymous && !!reviewerName;
  return {
    id: row.id,
    rating: row.rating,
    ...(row.title ? { title: row.title } : {}),
    body: row.body,
    outcome_label: row.outcomeLabel,
    ...(showName
      ? { reviewer_name: reviewerName }
      : {
          ...(row.displayMajor ? { display_major: row.displayMajor } : {}),
          ...(row.displayYear !== null ? { display_year: row.displayYear } : {}),
        }),
    ...(row.reply ? { reply: { body: row.reply.body, created_at: row.reply.createdAt.toISOString() } } : {}),
    published_at: (row.publishedAt ?? row.createdAt).toISOString(),
  };
}

