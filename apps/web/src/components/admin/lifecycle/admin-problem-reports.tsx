'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Paginated, ProblemReportItem, ProblemReportStatus } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { PROBLEM_CATEGORY_LABEL, PROBLEM_FOLLOW_UP_LABEL, PROBLEM_STATUS_VIEW } from '@/components/problem-reports/problem-report-meta';
import { formatDateTime } from '@/components/student/application-ui';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 20;
const STATUSES: ProblemReportStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];

type Overdue = '' | 'true' | 'false';
type Filters = { status: '' | ProblemReportStatus; overdue: Overdue; page: number };

function readFilters(params: URLSearchParams): Filters {
  const status = params.get('status') as ProblemReportStatus | null;
  const overdue = params.get('overdue');
  const page = Number(params.get('page'));
  return {
    status: status && STATUSES.includes(status) ? status : '',
    overdue: overdue === 'true' || overdue === 'false' ? overdue : '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.overdue) query.set('overdue', filters.overdue);
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.toString();
}

/**
 * รายงานปัญหาระหว่างฝึกงานทุกรายการ (README §5.2.2, UAT-39) — `GET /admin/lifecycle/problem-reports?status=&overdue=`
 * เรียงตามกำหนดดำเนินการ (ใกล้/เลยกำหนดก่อน) • ตัวกรองอยู่ใน URL • อาจารย์เป็นผู้รับเรื่อง/ปิดเรื่อง หน้านี้ Admin ใช้ติดตาม
 * ถ้าต้องยุติการฝึก ⇒ ลิงก์ไปฟอร์มยุติที่หน้า "ใบสมัครที่รอดำเนินการ" พร้อมรหัสใบสมัคร (Admin ใส่เหตุผลและยืนยันเอง)
 */
export function AdminProblemReports() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const filters = readFilters(new URLSearchParams(searchParams.toString()));
  const queryString = toQuery(filters);

  const [result, setResult] = useState<Paginated<ProblemReportItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const current = readFilters(new URLSearchParams(queryString));
    const apiQuery = new URLSearchParams({ page: String(current.page), page_size: String(PAGE_SIZE) });
    if (current.status) apiQuery.set('status', current.status);
    if (current.overdue) apiQuery.set('overdue', current.overdue);
    request<Paginated<ProblemReportItem>>(`/admin/lifecycle/problem-reports?${apiQuery.toString()}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) { setResult(null); setError(cause instanceof ApiError ? cause.message : 'โหลดรายงานปัญหาไม่สำเร็จ'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [queryString, request]);

  const update = useCallback((patch: Partial<Filters>) => {
    const query = toQuery({ ...filters, page: 1, ...patch });
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [filters, pathname, router]);

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">รายงานปัญหาระหว่างฝึกงาน</h1>
        <p className="mt-1 text-sm text-ink-soft">
          รายงานจากนักศึกษาทุกราย ส่งถึงอาจารย์ที่ปรึกษาและผู้ดูแลระบบพร้อมกัน บริษัทมองไม่เห็น อาจารย์เป็นผู้รับเรื่องและปิดเรื่อง
          หน้านี้ใช้ติดตามรายงานที่ค้างหรือเลยกำหนด และยุติการฝึกเมื่อพบปัญหาร้ายแรง
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="สถานะ" value={filters.status} onChange={(status) => update({ status: status as Filters['status'] })}
          options={[['', 'ทั้งหมด'], ...STATUSES.map((code): [string, string] => [code, PROBLEM_STATUS_VIEW[code].label])]} />
        <FilterSelect label="กำหนดดำเนินการ" value={filters.overdue} onChange={(overdue) => update({ overdue: overdue as Overdue })}
          options={[['', 'ทั้งหมด'], ['true', 'เลยกำหนด (OVERDUE)'], ['false', 'ยังไม่เลยกำหนด/ปิดแล้ว']]} />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {loading && !result && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
      {!loading && !error && result && result.data.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-ink-soft">ไม่มีรายงานตามตัวกรองนี้</p>
      )}

      <ul className="space-y-4">
        {result?.data.map((report) => {
          const view = PROBLEM_STATUS_VIEW[report.status];
          return (
            <li key={report.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold">{PROBLEM_CATEGORY_LABEL[report.category]}</h2>
                  <p className="text-xs text-ink-soft">รายงานเมื่อ {formatDateTime(report.created_at)} · กำหนดดำเนินการ {formatDateTime(report.due_at)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {report.overdue && <StatusBadge tone="danger">OVERDUE</StatusBadge>}
                  <StatusBadge tone={view.tone} icon={view.icon}>{view.label}</StatusBadge>
                </div>
              </div>
              <p className="mt-3 whitespace-pre-line break-words text-sm">{report.detail}</p>
              {report.resolution_note && (
                <p className="mt-3 whitespace-pre-line break-words rounded-xl bg-surface-muted p-3 text-sm">
                  ผลการดำเนินการของอาจารย์: {report.resolution_note}
                  {report.follow_up_action && <span className="text-ink-soft"> ({PROBLEM_FOLLOW_UP_LABEL[report.follow_up_action]})</span>}
                </p>
              )}
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink-soft sm:grid-cols-2">
                <div><dt className="inline">ใบสมัคร: </dt><dd className="inline break-all font-mono">{report.application_id}</dd></div>
                <div><dt className="inline">นักศึกษา: </dt><dd className="inline break-all font-mono">{report.student_user_id}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                <Link href={`/admin/applications?terminate=${encodeURIComponent(report.application_id)}`}
                  className="rounded-full border border-danger px-4 py-1.5 font-semibold text-danger-text hover:bg-danger-soft">
                  ยุติการฝึกงานของใบสมัครนี้
                </Link>
                <Link href={`/admin/lifecycle-audit?target_id=${encodeURIComponent(report.application_id)}`}
                  className="rounded-full border border-border px-4 py-1.5 hover:bg-surface-muted">
                  ประวัติใน Audit log
                </Link>
              </div>
            </li>
          );
        })}
      </ul>

      {result && total > 0 && (
        <div className="flex items-center justify-between text-sm text-ink-soft">
          <span>ทั้งหมด {total} รายการ · หน้า {filters.page} จาก {lastPage}</span>
          <span className="flex gap-2">
            <button type="button" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ก่อนหน้า</button>
            <button type="button" disabled={filters.page >= lastPage} onClick={() => update({ page: filters.page + 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ถัดไป</button>
          </span>
        </div>
      )}
    </div>
  );
}
