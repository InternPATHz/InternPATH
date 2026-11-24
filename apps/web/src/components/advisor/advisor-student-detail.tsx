'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { AdvisorStudentOverview } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApplicationStatusBadge, formatDate } from '@/components/student/application-ui';
import { Avatar } from '@/components/ui/avatar';
import { ApiError } from '@/lib/api';

export function AdvisorStudentDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { request } = useAuth();
  const [overview, setOverview] = useState<AdvisorStudentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setOverview(null);
    if (!id) { setError('ไม่พบนักศึกษาคนนี้'); return; }
    setError(null);
    void request<AdvisorStudentOverview>(`/advisor/students/${encodeURIComponent(id)}/overview`).then(
      (value) => { if (active) setOverview(value); },
      (cause) => {
        if (active) setError(cause instanceof ApiError && cause.status === 404 ? 'ไม่พบนักศึกษาในความดูแล' : 'โหลดข้อมูลนักศึกษาไม่สำเร็จ');
      },
    );
    return () => { active = false; };
  }, [id, request]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Link href="/advisor/students" className="text-sm font-medium text-primary hover:underline">← นักศึกษาในความดูแล</Link>
      {!overview && <h1 className="mt-3 text-3xl font-semibold">รายละเอียดนักศึกษา</h1>}
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}
      {!error && !overview && <p role="status" className="mt-4 text-sm text-ink-soft">กำลังโหลด…</p>}
      {overview && (
        <>
          <header className="mt-5 flex flex-wrap items-center gap-4">
            <Avatar name={overview.full_name} />
            <h1 className="min-w-0 break-words text-3xl font-semibold">{overview.full_name || 'รายละเอียดนักศึกษา'}</h1>
          </header>
          <section className="mt-6" aria-labelledby="student-applications">
            <h2 id="student-applications" className="text-xl font-semibold">ความคืบหน้าการฝึกงาน</h2>
            {overview.applications.length === 0 && <p className="mt-3 rounded-xl bg-surface-muted p-5 text-sm text-ink-soft">ยังไม่มีใบสมัครฝึกงาน</p>}
            <ul className="mt-3 space-y-3">
              {overview.applications.map((app) => (
                <li key={app.id} className="rounded-xl border border-border p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                      <h3 className="font-semibold">{app.job_title}</h3>
                      <p className="text-sm text-ink-soft">{app.company_name}</p>
                    </div>
                    <ApplicationStatusBadge status={app.status} />
                  </div>
                  <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <div><dt className="text-xs text-ink-soft">อัปเดตล่าสุด</dt><dd>{formatDate(app.status_changed_at)}</dd></div>
                    {app.start_date && <div><dt className="text-xs text-ink-soft">เริ่มฝึก</dt><dd>{formatDate(app.actual_start_date ?? app.start_date)}</dd></div>}
                    {app.end_date && <div><dt className="text-xs text-ink-soft">สิ้นสุดการฝึก</dt><dd>{formatDate(app.actual_end_date ?? app.end_date)}</dd></div>}
                  </dl>
                  {app.major_mismatch && <p className="mt-3 text-sm text-warning-text">สาขาไม่ตรงกับที่ประกาศระบุ</p>}
                  {app.frozen && <p className="mt-3 text-sm text-warning-text">ประกาศถูกระงับชั่วคราว</p>}
                  {app.status === 'ADVISOR_PENDING' && (
                    <Link href="/advisor/approvals" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">เปิดคิวอนุมัติ ›</Link>
                  )}
                  {['FAIL_DISPUTED', 'EVALUATED_PASS', 'EVALUATED_FAIL', 'NO_EVALUATION'].includes(app.status) && (
                    <Link href="/advisor/evaluations" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">เปิดหน้าประเมินผล ›</Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
