import { randomUUID } from 'node:crypto';
import { AppException, type JwtClaims } from '@internpath/common';
import type {
  HrApplicationDetail,
  HrApplicationItem,
  HrStartResponse,
  Paginated,
  StudentProfile,
} from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Application } from '../../../generated/client';
import { assertCompanyOwnership } from '../../common/auth/ownership';
import { LifecycleConfigService } from '../../config/lifecycle-config.service';
import { IdentityInternalClient } from '../../internal/identity-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationStateMachine } from '../../state-machine/application-state-machine.service';
import type { TransitionCommand } from '../../state-machine/application-transition.service';
import { bangkokToday, daysBetween, toDateOnly } from '../../state-machine/dates';
import { applicationNotFound, validationFailed } from '../../state-machine/errors';
import { startWarning } from '../../state-machine/guards';
import type { Actor } from '../../state-machine/status-history.writer';
import { loadSnapshotNames, toHrDetail, toHrItem } from '../applications/application-view';
import type { HrAcceptDto, HrApplicationsQueryDto, HrEvaluateDto, HrStartDto, HrTerminateDto } from './hr-applications.dto';

/** action ของ HR ที่รับแค่เหตุผล — `reject` (ไม่บังคับ), `rescind-offer` (บังคับใน Guard) */
export type HrReasonAction = 'reject' | 'rescind-offer';

type HrProfile = StudentProfile & { full_name: string };

/**
 * ใบสมัครฝั่ง HR (api-contract §7.3, data-schema §8.1, README §5.2)
 * - กรองด้วย `company_id` ใน Token ที่ Service เอง (README §5.7): ใบของบริษัทอื่น ⇒ `403 NOT_OWNER_OF_RESOURCE` (UAT-29 ข้อ 2)
 * - โปรไฟล์นักศึกษาเห็นได้เฉพาะเมื่อมี Consent (README §5.11) • ไม่ส่งรายงานปัญหาระหว่างฝึกงานให้ HR
 * - การเปลี่ยนสถานะทั้งหมดผ่าน `ApplicationStateMachine` (Guard/โควตา/Transaction/status_history/E08)
 */
@Injectable()
export class HrApplicationsService {
  private readonly logger = new Logger(HrApplicationsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly identity: IdentityInternalClient,
    private readonly stateMachine: ApplicationStateMachine,
    private readonly config: LifecycleConfigService,
  ) {}

  // ---------- GET ----------

  async list(user: JwtClaims, query: HrApplicationsQueryDto): Promise<Paginated<HrApplicationItem>> {
    const companyId = requireCompany(user);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where = {
      companyId,
      ...(query.job_id ? { jobId: query.job_id } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.application.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.application.count({ where }),
    ]);
    const names = await loadSnapshotNames(this.db, rows);
    return { data: rows.map((row) => toHrItem(row, names)), meta: { page, page_size: pageSize, total } };
  }

  /** GET /hr/applications/{id} — โปรไฟล์เฉพาะเมื่อมี Consent + `available_actions[]`/`accept_blocked_reason` */
  async detail(user: JwtClaims, applicationId: string, correlationId?: string, now = new Date()): Promise<HrApplicationDetail> {
    const app = await this.companyApplication(user, applicationId);
    const [names, actions, profile] = await Promise.all([
      loadSnapshotNames(this.db, [app]),
      this.stateMachine.availableActions(app, 'COMPANY_HR', now),
      this.consentedProfile(app, correlationId),
    ]);
    return toHrDetail(app, names, profile, actions);
  }

  // ---------- Actions ----------

  /** `accept` `{start_date, end_date}` — Guard: ไม่ Freeze, ไม่ยืนยันที่อื่น (403), ช่วง ≥ 30 วัน (422) → reserve โควตา (409 QUOTA_FULL) */
  async accept(user: JwtClaims, applicationId: string, body: HrAcceptDto, correlationId?: string): Promise<HrApplicationDetail> {
    await this.companyApplication(user, applicationId);
    await this.execute(user, applicationId, {
      trigger: 'accept',
      input: { startDate: toDateOnly(body.start_date), endDate: toDateOnly(body.end_date) },
    }, correlationId);
    return this.detail(user, applicationId, correlationId);
  }

  /** `reject` (`PENDING` เท่านั้น) / `rescind-offer` (`HR_ACCEPTED`/`ADVISOR_PENDING`/`ADVISOR_APPROVED` + release โควตา) */
  async transition(
    user: JwtClaims,
    applicationId: string,
    action: HrReasonAction,
    reason: string | undefined,
    correlationId?: string,
  ): Promise<HrApplicationDetail> {
    await this.companyApplication(user, applicationId);
    await this.execute(user, applicationId, { trigger: action, reason }, correlationId);
    return this.detail(user, applicationId, correlationId);
  }

  /**
   * `start` `{actual_start_date, start_date?, end_date?}` → `IN_PROGRESS` + confirm โควตา (UAT-35)
   * ปรับ `start_date`/`end_date` ได้ • `end_date − actual_start_date < 30` ⇒ สำเร็จแต่คืน `warning: NO_CERTIFICATE_ELIGIBLE`
   */
  async start(
    user: JwtClaims,
    applicationId: string,
    body: HrStartDto,
    correlationId?: string,
    now = new Date(),
  ): Promise<HrApplicationDetail & HrStartResponse> {
    const app = await this.companyApplication(user, applicationId);
    const actualStart = toDateOnly(body.actual_start_date);
    const startDate = body.start_date ? toDateOnly(body.start_date) : app.startDate;
    const endDate = body.end_date ? toDateOnly(body.end_date) : app.endDate;

    if (daysBetween(bangkokToday(now), actualStart) > 0) throw validationFailed('actual_start_date', 'IN_FUTURE');
    if (startDate && endDate && daysBetween(startDate, endDate) <= 0) {
      throw validationFailed('end_date', 'NOT_AFTER_START_DATE');
    }
    if (endDate && daysBetween(actualStart, endDate) <= 0) {
      throw validationFailed('end_date', 'NOT_AFTER_ACTUAL_START_DATE');
    }

    await this.execute(user, applicationId, {
      trigger: 'start',
      patch: {
        actualStartDate: actualStart,
        ...(body.start_date && startDate ? { startDate } : {}),
        ...(body.end_date && endDate ? { endDate } : {}),
      },
    }, correlationId, now);

    const minActualDays = await this.config.getNumber('CERT_MIN_ACTUAL_DAYS');
    const warning = startWarning(actualStart, endDate, minActualDays);
    const detail = await this.detail(user, applicationId, correlationId);
    return warning ? { ...detail, warning } : detail;
  }

  /**
   * `terminate` `{reason, actual_end_date?}` → `TERMINATED`, `terminated_by = COMPANY` (UAT-20)
   * ไม่ release โควตา (confirm แล้ว) • `actual_end_date` ไม่ส่ง ⇒ วันนี้ (เวลากรุงเทพ)
   */
  async terminate(
    user: JwtClaims,
    applicationId: string,
    body: HrTerminateDto,
    correlationId?: string,
    now = new Date(),
  ): Promise<HrApplicationDetail> {
    const app = await this.companyApplication(user, applicationId);
    if (body.actual_end_date) {
      const actualEnd = toDateOnly(body.actual_end_date);
      if (daysBetween(bangkokToday(now), actualEnd) > 0) throw validationFailed('actual_end_date', 'IN_FUTURE');
      if (app.actualStartDate && daysBetween(app.actualStartDate, actualEnd) < 0) {
        throw validationFailed('actual_end_date', 'BEFORE_ACTUAL_START_DATE');
      }
    }
    await this.execute(user, applicationId, {
      trigger: 'terminate',
      reason: body.reason,
      ...(body.actual_end_date ? { patch: { actualEndDate: toDateOnly(body.actual_end_date) } } : {}),
    }, correlationId, now);
    return this.detail(user, applicationId, correlationId);
  }

  /**
   * `evaluate` `{result, reason?, note?}` — เปิดเมื่อถึง `end_date` หรือ `TERMINATED` ที่ฝึกจริง ≥ 30 วัน (`422 EVALUATION_NOT_OPEN`)
   * FAIL ต้องมีเหตุผล (`400 REASON_REQUIRED`) • เขียน `evaluations` ใน Transaction เดียวกัน:
   * `round = 2` เฉพาะจาก `REEVALUATION_REQUESTED` (data-schema §8.1) นอกนั้น `round = 1`
   */
  async evaluate(user: JwtClaims, applicationId: string, body: HrEvaluateDto, correlationId?: string): Promise<HrApplicationDetail> {
    await this.companyApplication(user, applicationId);
    const reason = body.reason || undefined;
    await this.execute(user, applicationId, {
      trigger: 'evaluate',
      to: body.result === 'PASS' ? 'EVALUATED_PASS' : 'EVALUATED_FAIL',
      reason,
      afterTransition: async (tx, after) => {
        // `before.status` ไม่ส่งมากับ callback ⇒ ใช้ `reevaluation_used` (ตั้งตอน → REEVALUATION_REQUESTED และไม่ถูกล้าง)
        const round = after.reevaluationUsed ? 2 : 1;
        await tx.evaluation.create({
          data: {
            applicationId: after.id,
            round,
            result: body.result,
            reason: reason ?? null,
            scoreNote: body.note || null,
            evaluatedBy: user.sub,
          },
        });
      },
    }, correlationId);
    return this.detail(user, applicationId, correlationId);
  }

  // ---------- helper ----------

  private async execute(
    user: JwtClaims,
    applicationId: string,
    command: Omit<TransitionCommand, 'actor' | 'correlationId'>,
    correlationId: string | undefined,
    now = new Date(),
  ): Promise<void> {
    const actor: Actor = { userId: user.sub, role: 'COMPANY_HR' };
    await this.stateMachine.execute(
      applicationId,
      { ...command, actor, correlationId: correlationId ?? randomUUID() },
      now,
    );
  }

  /** ไม่มี ⇒ 404 • บริษัทอื่น ⇒ 403 `NOT_OWNER_OF_RESOURCE` (UAT-29 ข้อ 2 — เหมือนเรซูเม่ใน 1.3) */
  private async companyApplication(user: JwtClaims, applicationId: string): Promise<Application> {
    const app = await this.db.application.findUnique({ where: { id: applicationId } });
    if (!app) throw applicationNotFound();
    assertCompanyOwnership(user, app.companyId);
    return app;
  }

  /**
   * โปรไฟล์นักศึกษาเมื่อมี Consent ให้บริษัทนี้เท่านั้น (README §5.11) — ไม่มี Consent/Identity ล่ม ⇒ ไม่ส่ง `profile`
   * (fail-closed เฉพาะข้อมูลส่วนบุคคล ไม่ทำให้ทั้งหน้าใช้ไม่ได้)
   * ใช้โปรไฟล์ของ Lifecycle (`student_profiles`); ยังไม่เคยสร้าง ⇒ ใช้ major/year_level จาก Identity
   * `full_name` ดึงสดจาก Identity (`students/{id}`) ทุกครั้ง — **ห้ามเก็บลง DB/cache/log** (api-contract §9)
   * Identity อ่านไม่ได้ (ล่ม/บัญชีถูกระงับ) แต่มีโปรไฟล์ใน Lifecycle ⇒ ส่งโปรไฟล์โดย `full_name` ว่าง
   */
  private async consentedProfile(app: Application, correlationId?: string): Promise<HrProfile | undefined> {
    try {
      const consent = await this.identity.checkConsent(app.studentUserId, app.companyId, correlationId);
      if (!consent.has_consent) return undefined;
    } catch {
      this.logger.warn('ตรวจ Consent ไม่สำเร็จ — ไม่แสดงโปรไฟล์นักศึกษา');
      return undefined;
    }

    const [local, student] = await Promise.all([
      this.db.studentProfile.findUnique({ where: { userId: app.studentUserId } }),
      this.identity.getStudent(app.studentUserId, correlationId).catch(() => {
        this.logger.warn('อ่านข้อมูลนักศึกษาจาก Identity ไม่สำเร็จ — ไม่มีชื่อนักศึกษา');
        return null;
      }),
    ]);
    const fullName = student?.full_name ?? '';
    if (local) {
      return {
        ...(local.headline ? { headline: local.headline } : {}),
        skills: local.skills,
        ...(local.bio ? { bio: local.bio } : {}),
        ...(local.portfolioUrl ? { portfolio_url: local.portfolioUrl } : {}),
        major: local.major,
        year_level: local.yearLevel,
        full_name: fullName,
      };
    }
    if (!student) return undefined;
    return { skills: [], major: student.major, year_level: student.year_level, full_name: fullName };
  }
}

/** HR ที่ไม่มี `company_id` ใน Token ⇒ `403 NOT_OWNER_OF_RESOURCE` (เหมือน `assertCompanyOwnership`) */
function requireCompany(user: JwtClaims): string {
  if (!user.company_id) {
    throw new AppException('NOT_OWNER_OF_RESOURCE', 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทอื่น', 403);
  }
  return user.company_id;
}
