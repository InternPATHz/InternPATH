import type {
  ApplicationAction,
  ApplicationBase,
  ApplicationStatus,
  ApplicationTimelineEntry,
  StudentApplicationDetail,
} from '@internpath/contracts';
import type { Application, StatusHistory } from '../../../generated/client';
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

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
