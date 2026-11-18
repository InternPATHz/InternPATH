import type {
  ApplicationAction,
  ApplicationBase,
  ApplicationStatus,
  AdvisorApplicationItem,
  ApplicationTimelineEntry,
  CertificateItem,
  EvaluationView,
  HrApplicationDetail,
  HrApplicationItem,
  StudentApplicationDetail,
  StudentApplicationItem,
  StudentProfile,
} from '@internpath/contracts';
import type { Application, Certificate, Evaluation, StatusHistory } from '../../../generated/client';
import type { Tx } from '../../prisma/types';

/**
 * แปลงแถว `applications` เป็น Response ตาม `@internpath/contracts` (dto/lifecycle-responses.ts)
 * ชื่อประกาศ/บริษัทมาจาก `job_snapshots`/`company_snapshots` ของ Lifecycle เอง (ห้ามอ่านตาราง Service อื่น)
 * ใช้ซ้ำได้ใน 1.5/1.6 (HR/อาจารย์)
 */

export interface SnapshotNames {
  jobTitles: Map<string, string>;
  companyNames: Map<string, string>;
}

/** คอลัมน์ `@db.Date` (เที่ยงคืน UTC) ⇒ `YYYY-MM-DD` */
export const formatDate = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString().slice(0, 10) : undefined;

/** โหลดชื่อประกาศ/บริษัทของหลายใบในคราวเดียว — ยังไม่มี snapshot (Event มาไม่ถึง) ⇒ ชื่อว่าง */
export async function loadSnapshotNames(
  db: Pick<Tx, 'jobSnapshot' | 'companySnapshot'>,
  apps: ReadonlyArray<Pick<Application, 'jobId' | 'companyId'>>,
): Promise<SnapshotNames> {
  const jobIds = [...new Set(apps.map((a) => a.jobId))];
  const companyIds = [...new Set(apps.map((a) => a.companyId))];
  const [jobs, companies] = await Promise.all([
    jobIds.length
      ? db.jobSnapshot.findMany({ where: { jobId: { in: jobIds } }, select: { jobId: true, title: true } })
      : Promise.resolve([]),
    companyIds.length
      ? db.companySnapshot.findMany({
          where: { companyId: { in: companyIds } },
          select: { companyId: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    jobTitles: new Map(jobs.map((j) => [j.jobId, j.title])),
    companyNames: new Map(companies.map((c) => [c.companyId, c.name])),
  };
}

export function toApplicationBase(app: Application, names: SnapshotNames): ApplicationBase {
  return {
    id: app.id,
    job_id: app.jobId,
    job_title: names.jobTitles.get(app.jobId) ?? '',
    company_id: app.companyId,
    company_name: names.companyNames.get(app.companyId) ?? '',
    status: app.status,
    major_mismatch: app.majorMismatch,
    ...optional('start_date', formatDate(app.startDate)),
    ...optional('end_date', formatDate(app.endDate)),
    ...optional('actual_start_date', formatDate(app.actualStartDate)),
    ...optional('actual_end_date', formatDate(app.actualEndDate)),
    frozen: app.frozen,
    status_changed_at: app.statusChangedAt.toISOString(),
    created_at: app.createdAt.toISOString(),
  };
}

/** Timeline จาก `status_history` (entity `APPLICATION`) เรียงเก่า → ใหม่; แถวสร้างใบสมัครไม่มี `from_status` */
export function toTimeline(rows: readonly StatusHistory[]): ApplicationTimelineEntry[] {
  return rows.map((row) => ({
    ...(row.fromStatus ? { from_status: row.fromStatus as ApplicationStatus } : {}),
    to_status: row.toStatus as ApplicationStatus,
    actor_role: row.actorRole,
    ...(row.reason ? { reason: row.reason } : {}),
    occurred_at: row.occurredAt.toISOString(),
  }));
}

export function toStudentDetail(
  app: Application,
  names: SnapshotNames,
  history: readonly StatusHistory[],
  actions: ApplicationAction[],
): StudentApplicationDetail {
  return {
    ...toApplicationBase(app, names),
    ...optional('cover_letter', app.coverLetter ?? undefined),
    ...optional('terminated_by', app.terminatedBy ?? undefined),
    ...optional('terminate_reason', app.terminateReason ?? undefined),
    ...optional('academic_result', app.academicResult ?? undefined),
    timeline: toTimeline(history),
    available_actions: actions,
  };
}

/** รายการ GET /advisor/applications (และผลของ action ฝั่งอาจารย์) — `student_name` จาก `StudentNamesService` */
export function toAdvisorItem(app: Application, names: SnapshotNames, studentName: string): AdvisorApplicationItem {
  return {
    ...toApplicationBase(app, names),
    student_user_id: app.studentUserId,
    student_name: studentName,
    flagged_for_advisor: app.flaggedForAdvisor,
  };
}

/** รายการ GET /hr/applications — ไม่มีโปรไฟล์/ข้อความ (ดูได้ในรายละเอียดหลังตรวจ Consent) */
/** รายการ GET /me/applications และ POST /applications — มี `academic_result` เมื่ออาจารย์บันทึกแล้ว (ป้าย COMPLETED ผ่าน/ไม่ผ่าน) */
export function toStudentItem(app: Application, names: SnapshotNames): StudentApplicationItem {
  return { ...toApplicationBase(app, names), ...optional('academic_result', app.academicResult ?? undefined) };
}

/** `studentName` ดึงสดจาก Identity (`StudentNamesService`) — ว่าง (ล่ม/ไม่พบ) ⇒ ไม่มีฟิลด์ `student_name` */
export function toHrItem(app: Application, names: SnapshotNames, studentName?: string): HrApplicationItem {
  return {
    ...toApplicationBase(app, names),
    student_user_id: app.studentUserId,
    ...optional('student_name', studentName || undefined),
  };
}

/**
 * ผลประเมินล่าสุดของบริษัท (`EvaluationView` ใน contracts — PR #53) — HR ต้องเห็นตอน `REEVALUATION_REQUESTED`
 * `round` มีแค่ 1/2 (CHECK `evaluations_round_check`)
 */
export function toEvaluationView(row: Evaluation): EvaluationView {
  return {
    round: row.round as EvaluationView['round'],
    result: row.result,
    ...optional('reason', row.reason ?? undefined),
    ...optional('score_note', row.scoreNote ?? undefined),
    evaluated_at: row.evaluatedAt.toISOString(),
  };
}

/** `CertificateItem` (api-contract §7.5) — ใช้ทั้ง `GET /me/certificates`, ผลของ action ใบรับรอง และ `certificate?` ใน HR detail */
export function toCertificateItem(cert: Certificate): CertificateItem {
  return {
    id: cert.id,
    certificate_code: cert.certificateCode,
    company_name: cert.companyNameSnapshot,
    job_title: cert.jobTitleSnapshot,
    period: { start: formatDate(cert.periodStart) as string, end: formatDate(cert.periodEnd) as string },
    actual_days: cert.actualDays,
    status: cert.status,
    issued_at: cert.issuedAt.toISOString(),
  };
}

/**
 * GET /hr/applications/{id} — `profile` ใส่เฉพาะเมื่อ Consent (ผู้เรียกตัดสิน) • ไม่มีรายงานปัญหา (README §5.11)
 * `accept_blocked_reason` มีเมื่อ `accept` กดไม่ได้ (เช่นนักศึกษายืนยันที่อื่นแล้ว)
 */
export function toHrDetail(
  app: Application,
  names: SnapshotNames,
  profile: (StudentProfile & { full_name: string }) | undefined,
  actions: { available_actions: ApplicationAction[]; accept_blocked_reason?: string },
  extra: { evaluation?: Evaluation | null; certificate?: Certificate | null; studentName?: string } = {},
): HrApplicationDetail {
  return {
    ...toHrItem(app, names, extra.studentName),
    ...optional('cover_letter', app.coverLetter ?? undefined),
    ...optional('profile', profile),
    available_actions: actions.available_actions,
    ...optional('accept_blocked_reason', actions.accept_blocked_reason),
    ...optional('evaluation', extra.evaluation ? toEvaluationView(extra.evaluation) : undefined),
    // ใบที่เพิกถอนแล้วยังคืนพร้อม `status: 'REVOKED'` (contracts `HrApplicationDetail.certificate`)
    ...optional('certificate', extra.certificate ? toCertificateItem(extra.certificate) : undefined),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
