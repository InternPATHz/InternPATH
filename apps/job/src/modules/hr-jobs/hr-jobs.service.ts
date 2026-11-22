import { AppException, asUuid, OutboxWriter, type JwtClaims } from '@internpath/common';
import type {
  HrJobDetail,
  JobSubmittedPayload,
  Paginated,
  UpdateJobResponse,
} from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { Prisma, type Job, type JobCategory, type Tag } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { Tx } from '../../prisma/types';
import { JobStatusTransitionService } from '../../status/job-status-transition.service';
import type { HrJobsQueryDto, WriteJobDto } from './dto';
import {
  availableQuota,
  changeFields,
  jobFields,
  jobTags,
  presentJob,
  requireFields,
  type JobWithTags,
} from './hr-job-fields';

const editable = ['DRAFT', 'PUBLISHED', 'ADMIN_REJECTED', 'CLOSED'];
const closedFields = ['quota', 'application_deadline', 'target_majors', 'period'];

const notFound = () => new AppException('NOT_FOUND', 'ไม่พบประกาศงาน', 404);
const stateConflict = () =>
  new AppException('STATE_CONFLICT', 'สถานะประกาศไม่อนุญาตให้ทำรายการนี้', 409);
const invalidTags = (issue: 'TAG_UNKNOWN' | 'TAG_INACTIVE' | 'TAGS_COUNT') =>
  new AppException('VALIDATION_FAILED', 'Tag ทักษะไม่ถูกต้อง', 400, [{ field: 'tag_ids', issue }]);

@Injectable()
export class HrJobsService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly transitions: JobStatusTransitionService,
    private readonly outbox: OutboxWriter,
  ) {}

  async list(user: JwtClaims, query: HrJobsQueryDto): Promise<Paginated<HrJobDetail>> {
    const companyId = this.companyId(user);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const categories = user.company_role === 'MEMBER' ? [...(user.company_categories ?? [])] : null;
    const where = {
      companyId,
      status: query.status,
      category: categories
        ? {
            in: query.category
              ? categories.filter((category) => category === query.category)
              : categories,
          }
        : query.category,
    };
    const [jobs, total, company, entitlement] = await this.db.$transaction(
      [
        this.db.job.findMany({
          where,
          include: { tags: jobTags },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: pageSize,
          skip: (page - 1) * pageSize,
        }),
        this.db.job.count({ where }),
        this.db.companySnapshot.findUnique({ where: { companyId } }),
        this.db.companyEntitlement.findUnique({ where: { companyId } }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      data: jobs.map((job) =>
        presentJob(job, company, entitlement?.featuredEnabled ?? false, this.publicBase()),
      ),
      meta: { page, page_size: pageSize, total },
    };
  }

  async detail(user: JwtClaims, id: string): Promise<HrJobDetail> {
    const job = await this.findOwned(this.db, user, id);
    return this.present(this.db, job);
  }

  async create(user: JwtClaims, body: WriteJobDto): Promise<HrJobDetail> {
    const companyId = this.companyId(user);
    this.requireCategory(user, body.category);
    return this.db.$transaction(async (tx) => {
      await this.requireVerified(tx, companyId);
      const tagIds = body.tag_ids === undefined ? [] : await this.activeTagIds(tx, body.tag_ids);
      const job = await tx.job.create({
        data: {
          ...jobFields(body),
          companyId,
          createdBy: user.sub,
          status: 'DRAFT',
          version: 1,
          entityVersion: 1,
          targetMajors: body.target_majors ?? [],
          tags: { create: tagIds.map((tagId) => ({ tagId })) },
        },
        include: { tags: jobTags },
      });
      return this.present(tx, job);
    });
  }

  async update(
    user: JwtClaims,
    id: string,
    body: WriteJobDto,
    correlationId: string,
  ): Promise<UpdateJobResponse> {
    return this.db.$transaction(async (tx) => {
      const job = await this.lockOwned(tx, user, id);
      if (!editable.includes(job.status)) throw stateConflict();
      const { category, ...remaining } = body;
      let fields = body;
      if (job.status !== 'DRAFT' && category !== undefined) {
        if (category !== job.category) {
          throw new AppException('VALIDATION_FAILED', 'เปลี่ยนสายงานได้เฉพาะประกาศฉบับร่าง', 400, [
            { field: 'category', issue: 'CATEGORY_LOCKED' },
          ]);
        }
        fields = remaining;
        if (Object.values(fields).every((value) => value === undefined)) {
          return { ...(await this.present(tx, job)), requires_reverification: false };
        }
      }

      if (
        job.status === 'CLOSED' &&
        Object.entries(fields).some(
          ([field, value]) => value !== undefined && !closedFields.includes(field),
        )
      ) {
        throw stateConflict();
      }
      if (job.status === 'DRAFT' && category !== undefined) this.requireCategory(user, category);
      if (
        fields.quota !== undefined &&
        fields.quota < (job.quotaReserved ?? 0) + (job.quotaConfirmed ?? 0)
      ) {
        throw new AppException('QUOTA_BELOW_COMMITTED', 'จำนวนที่รับต่ำกว่าโควตาที่จองหรือยืนยันแล้ว', 422);
      }
      const tagIds =
        fields.tag_ids === undefined ? undefined : await this.activeTagIds(tx, fields.tag_ids);
      const changes = jobFields(fields);
      const next = { ...job };
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) Object.assign(next, { [key]: value });
      }
      if (job.status !== 'DRAFT') requireFields(next);
      const changedFields = changeFields(job, next);
      const requiresReverification =
        job.status === 'PUBLISHED' &&
        changedFields.length > 0 &&
        (await this.underReview(tx, job.companyId));
      if (requiresReverification) {
        await this.submitForReview(
          tx,
          user,
          job,
          next,
          'EDIT',
          changedFields,
          correlationId,
          changes,
        );
      } else {
        await tx.job.update({ where: { id }, data: { ...changes, version: { increment: 1 } } });
      }
      if (tagIds !== undefined) {
        await tx.jobTag.deleteMany({ where: { jobId: id } });
        await tx.jobTag.createMany({ data: tagIds.map((tagId) => ({ jobId: id, tagId })) });
      }
      return { ...(await this.reload(tx, id)), requires_reverification: requiresReverification };
    });
  }

  async submit(user: JwtClaims, id: string, correlationId: string): Promise<HrJobDetail> {
    return this.db.$transaction(async (tx) => {
      const job = await this.lockOwned(tx, user, id);
      if (job.status !== 'DRAFT' && job.status !== 'ADMIN_REJECTED') throw stateConflict();
      await this.requireVerified(tx, job.companyId);
      requireFields(job, job.tags.length);
      if (await this.underReview(tx, job.companyId)) {
        const kind = job.status === 'DRAFT' ? 'NEW' : 'RESUBMIT';
        await this.submitForReview(tx, user, job, job, kind, [], correlationId);
      } else {
        const now = new Date();
        const changed = await this.transitions.change(
          tx,
          job,
          {
            to: 'PUBLISHED',
            correlationId,
            historyReason: 'SUBMIT',
            actorRole: 'COMPANY_HR',
            actorId: user.sub,
            applicationEffect: 'NONE',
            adminReason: null,
            changes: { publishedAt: now, currentSubmissionId: null, verifyingSince: null },
          },
          now,
        );
        if (!changed) throw stateConflict();
      }
      return this.reload(tx, id);
    });
  }

  async setClosed(
    user: JwtClaims,
    id: string,
    closed: boolean,
    correlationId: string,
  ): Promise<HrJobDetail> {
    return this.db.$transaction(async (tx) => {
      const job = await this.lockOwned(tx, user, id);
      if (job.status !== (closed ? 'PUBLISHED' : 'CLOSED')) throw stateConflict();
      const now = new Date();
      if (!closed) {
        await this.requireVerified(tx, job.companyId);
        const today = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Bangkok',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(now);
        if (
          !job.applicationDeadline ||
          job.applicationDeadline.toISOString().slice(0, 10) < today ||
          (availableQuota(job) ?? 0) <= 0
        )
          throw stateConflict();
      }
      const changed = await this.transitions.change(
        tx,
        job,
        {
          to: closed ? 'CLOSED' : 'PUBLISHED',
          correlationId,
          historyReason: closed ? 'CLOSE' : 'REOPEN',
          actorRole: 'COMPANY_HR',
          actorId: user.sub,
          applicationEffect: 'NONE',
          changes: { closedAt: closed ? now : null },
        },
        now,
      );
      if (!changed) throw stateConflict();
      return this.reload(tx, id);
    });
  }

  async setFeatured(user: JwtClaims, id: string, enabled: boolean): Promise<HrJobDetail> {
    return this.db.$transaction(async (tx) => {
      const job = await this.lockOwned(tx, user, id);
      if (job.status !== 'PUBLISHED') throw stateConflict();
      const entitlement = await tx.companyEntitlement.findUnique({
        where: { companyId: job.companyId },
      });
      if (!entitlement?.featuredEnabled)
        throw new AppException('FORBIDDEN_ROLE', 'บริษัทไม่มีสิทธิ์ตั้งประกาศแนะนำ', 403);
      await tx.job.update({
        where: { id },
        data: { featured: enabled, version: { increment: 1 } },
      });
      return this.reload(tx, id);
    });
  }

  private async submitForReview(
    tx: Tx,
    user: JwtClaims,
    job: Job,
    next: Job,
    kind: JobSubmittedPayload['submission_kind'],
    changedFields: string[],
    correlationId: string,
    changes: Prisma.JobUpdateManyMutationInput = {},
  ): Promise<void> {
    const now = new Date();
    const cid = asUuid(correlationId);
    const submission = await tx.jobSubmission.create({
      data: { jobId: job.id, kind, changedFields, submittedBy: user.sub, submittedAt: now },
    });
    const changed = await this.transitions.change(
      tx,
      job,
      {
        to: 'VERIFYING',
        correlationId: cid,
        historyReason: kind,
        actorRole: 'COMPANY_HR',
        actorId: user.sub,
        applicationEffect: kind === 'EDIT' ? 'FREEZE' : 'NONE',
        adminReason: null,
        changes: { ...changes, currentSubmissionId: submission.id, verifyingSince: now },
      },
      now,
    );
    if (!changed) throw stateConflict();
    const entitlement = await tx.companyEntitlement.findUnique({
      where: { companyId: job.companyId },
    });
    // Completeness is checked before a submission or a published edit.
    const payload: JobSubmittedPayload = {
      job_id: job.id,
      company_id: job.companyId,
      submission_id: submission.id,
      submission_kind: kind,
      ...(kind === 'EDIT' ? { changed_fields: changedFields } : {}),
      content: {
        job_title: next.jobTitle!,
        description: next.description!,
        responsibilities: next.responsibilities!,
        qualifications: next.qualifications!,
        allowance_text: next.allowanceText ?? '',
        location: next.location!,
        ...(next.contactNotes ? { contact_notes: next.contactNotes } : {}),
      },
      work_mode: next.workMode!,
      hours_per_week: next.hoursPerWeek!,
      allowance: {
        type: next.allowanceType!,
        ...(next.allowanceType === 'AMOUNT' && next.allowanceAmountThb !== null
          ? { amount_thb: next.allowanceAmountThb }
          : {}),
      },
      company_flag_under_review: true,
      fast_track: entitlement?.fastTrackEnabled ?? false,
      submitted_at: now.toISOString(),
    };
    await this.outbox.add(tx, {
      type: 'JobSubmitted',
      aggregateId: job.id,
      correlationId: cid,
      payload,
    });
  }

  private companyId(user: JwtClaims): string {
    if (!user.company_id || !isUUID(user.company_id)) {
      throw new AppException('FORBIDDEN_ROLE', 'ไม่พบบริษัทในบัญชี HR', 403);
    }
    return user.company_id;
  }

  private requireCategory(user: JwtClaims, category?: JobCategory | null): void {
    if (
      user.company_role === 'MEMBER' &&
      (!category || !user.company_categories?.includes(category))
    ) {
      throw new AppException('FORBIDDEN_ROLE', 'ไม่มีสิทธิ์จัดการประกาศของสายงานนี้', 403, [
        { field: 'category', issue: 'FORBIDDEN_CATEGORY' },
      ]);
    }
  }

  private async requireVerified(tx: Tx, companyId: string): Promise<void> {
    const [company] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status::text FROM company_snapshots WHERE company_id = ${companyId}::uuid FOR SHARE
    `;
    if (company?.status !== 'VERIFIED')
      throw new AppException('COMPANY_NOT_VERIFIED', 'บริษัทยังไม่ผ่านการยืนยัน', 403);
  }

  private async underReview(tx: Tx, companyId: string): Promise<boolean> {
    const [flag] = await tx.$queryRaw<Array<{ under_review: boolean }>>`
      SELECT under_review FROM company_flags WHERE company_id = ${companyId}::uuid FOR SHARE
    `;
    return flag?.under_review ?? false;
  }

  private async activeTagIds(tx: Tx, input: unknown): Promise<string[]> {
    if (!Array.isArray(input) || input.length < 1 || input.length > 10)
      throw invalidTags('TAGS_COUNT');
    const ids = input.map((id: unknown) => {
      if (typeof id !== 'string' || !isUUID(id)) throw invalidTags('TAG_UNKNOWN');
      return id.toLowerCase();
    });
    if (new Set(ids).size !== ids.length) throw invalidTags('TAGS_COUNT');
    const tags = await tx.$queryRaw<Pick<Tag, 'id' | 'active'>[]>`
      SELECT id, active FROM tags WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE
    `;
    if (tags.length !== ids.length) throw invalidTags('TAG_UNKNOWN');
    if (tags.some((tag) => !tag.active)) throw invalidTags('TAG_INACTIVE');
    return ids;
  }

  private async lockOwned(tx: Tx, user: JwtClaims, id: string): Promise<JobWithTags> {
    if (!isUUID(id)) throw notFound();
    const companyId = this.companyId(user);
    // Quota writers also lock the Job row, so quota validation and writes use the same counters.
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM jobs WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
    `;
    if (!row) throw notFound();
    return this.findOwned(tx, user, row.id);
  }

  private async findOwned(tx: Tx, user: JwtClaims, id: string): Promise<JobWithTags> {
    if (!isUUID(id)) throw notFound();
    const job = await tx.job.findFirst({
      where: { id, companyId: this.companyId(user) },
      include: { tags: jobTags },
    });
    if (!job) throw notFound();
    this.requireCategory(user, job.category);
    return job;
  }

  private async reload(tx: Tx, id: string): Promise<HrJobDetail> {
    return this.present(
      tx,
      await tx.job.findUniqueOrThrow({ where: { id }, include: { tags: jobTags } }),
    );
  }

  private async present(tx: Tx, job: JobWithTags): Promise<HrJobDetail> {
    const companyId = job.companyId;
    const [company, entitlement] = await Promise.all([
      tx.companySnapshot.findUnique({ where: { companyId } }),
      tx.companyEntitlement.findUnique({ where: { companyId } }),
    ]);
    return presentJob(job, company, entitlement?.featuredEnabled ?? false, this.publicBase());
  }

  private publicBase(): string | undefined {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const bucket = this.config.get<string>('S3_BUCKET_PUBLIC');
    return (
      this.config.get<string>('S3_PUBLIC_BASE_URL') ||
      (endpoint && bucket ? `${endpoint.replace(/\/$/, '')}/${bucket}` : undefined)
    );
  }
}
