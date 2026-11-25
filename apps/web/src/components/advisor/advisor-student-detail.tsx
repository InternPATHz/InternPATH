'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { AdvisorDisputeItem, AdvisorStudentOverview, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Avatar } from '@/components/ui/avatar';
import { ApiError } from '@/lib/api';
import { useAdvisorDisputeDecision } from './advisor-dispute-decision';
import { AdvisorStudentApplication } from './advisor-student-application';
import { PAGE_SIZE } from './advisor-ui';

export function AdvisorStudentDetail() {
  const id = useSearchParams().get('id') ?? '';
  return <StudentDetail key={id} id={id} />;
}

function StudentDetail({ id }: { id: string }) {
  const { request } = useAuth();
  const [selected, setSelected] = useState('');
  const [overview, setOverview] = useState<AdvisorStudentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [disputes, setDisputes] = useState<Record<string, AdvisorDisputeItem> | null>(null);
  const [disputesFailed, setDisputesFailed] = useState(false);
  const { busyId, decide, message } = useAdvisorDisputeDecision(() => {
    setDisputes(null);
    setRevision((current) => current + 1);
  });

  useEffect(() => {
    if (!id) { setError('ไม่พบนักศึกษาคนนี้'); return; }
    let active = true;

    async function load() {
      let student: AdvisorStudentOverview;
      setError(null);
      setDisputesFailed(false);
      try {
        student = await request<AdvisorStudentOverview>(`/advisor/students/${encodeURIComponent(id)}/overview`);
        if (!active) return;
        setOverview(student);
      } catch (cause) {
        if (!active) return;
        setOverview(null);
        const missing = cause instanceof ApiError && (cause.status === 403 || cause.status === 404);
        setError(missing ? 'ไม่พบนักศึกษาในความดูแล' : 'โหลดข้อมูลนักศึกษาไม่สำเร็จ');
        return;
      }

      const pendingIds = new Set(student.applications.filter((app) => app.status === 'FAIL_DISPUTED').map((app) => app.id));
      const found: Record<string, AdvisorDisputeItem> = {};
      try {
        // The queue can only be filtered by page. Stop when this student's pending items have been found.
        let lastPage = 1;
        for (let page = 1; active && pendingIds.size > 0 && page <= lastPage; page++) {
          const result = await request<Paginated<AdvisorDisputeItem>>(`/advisor/disputes?page=${page}&page_size=${PAGE_SIZE}`);
          if (page === 1) lastPage = Math.ceil(result.meta.total / result.meta.page_size);
          for (const item of result.data) {
            if (item.student_user_id === id && pendingIds.delete(item.id)) found[item.id] = item;
          }
        }
        if (active) setDisputes(found);
      } catch {
        if (active) {
          setDisputes(found);
          setDisputesFailed(true);
        }
      }
    }

    void load();
    return () => { active = false; };
  }, [id, request, revision]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Link href="/advisor/students" className="text-sm font-medium text-primary hover:underline">← นักศึกษาในความดูแล</Link>
      {!overview && <h1 className="mt-3 text-3xl font-semibold">รายละเอียดนักศึกษา</h1>}
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}
      {!error && !overview && <p role="status" className="mt-4 text-sm text-ink-soft">กำลังโหลด…</p>}
      {overview && (
        <>
          <header className="mt-5 flex items-center gap-4">
            <Avatar name={overview.full_name} />
            <h1 className="min-w-0 text-3xl font-semibold [overflow-wrap:anywhere]">{overview.full_name || 'รายละเอียดนักศึกษา'}</h1>
          </header>
          {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
          <section className="mt-6" aria-labelledby="student-applications">
            <h2 id="student-applications" className="text-xl font-semibold">ความคืบหน้าการฝึกงาน</h2>
            {overview.applications.length === 0 && <p className="mt-3 rounded-xl bg-surface-muted p-5 text-sm text-ink-soft">ยังไม่มีใบสมัครฝึกงาน</p>}
            {overview.applications.length > 1 && <label className="mt-3 hidden text-sm lg:block">เลือกใบสมัคร
              <select className="ml-3 max-w-full rounded-lg border border-border p-2" value={overview.applications.find((app) => app.id === selected)?.id ?? overview.applications[0].id} onChange={(e) => setSelected(e.target.value)}>
                {overview.applications.map((app) => <option key={app.id} value={app.id}>{app.job_title} · {app.company_name}</option>)}
              </select></label>}
            <ul className="mt-3 space-y-4">
              {overview.applications.map((app) => (
                <AdvisorStudentApplication key={app.id} selected={app.id === (overview.applications.find((entry) => entry.id === selected)?.id ?? overview.applications[0]?.id)} app={app} dispute={disputes?.[app.id]}
                  loadingDispute={disputes === null} disputesFailed={disputesFailed} busy={busyId !== null} onDecide={decide} />
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
