'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AdvisorApplicationItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { PAGE_SIZE } from '@/components/advisor/advisor-ui';

const cards = [
  { title: 'คำขออนุมัติฝึกงาน', href: '/advisor/approvals', paths: ['/advisor/applications?status=ADVISOR_PENDING'] },
  { title: 'นักศึกษารอตั้งรหัสผ่าน', href: '/advisor/students', paths: ['/advisor-links/students?activation=PENDING'] },
  { title: 'คำโต้แย้งผลประเมิน', href: '/advisor/evaluations', paths: ['/advisor/disputes'] },
  { title: 'รายงานปัญหาที่ยังเปิด', href: '/advisor/problem-reports', paths: ['/advisor/problem-reports?status=OPEN'] },
  { title: 'รอบันทึกผลรายวิชา', href: '/advisor/evaluations', paths: [
    '/advisor/applications?status=EVALUATED_PASS&academic_recorded=false',
    '/advisor/applications?status=EVALUATED_FAIL&academic_recorded=false',
  ] },
  { title: 'กรณีบริษัทไม่ประเมิน', href: '/advisor/evaluations', paths: ['/advisor/applications?status=NO_EVALUATION&academic_recorded=false'] },
];

export function AdvisorHome() {
  const { request, user } = useAuth();
  const [counts, setCounts] = useState<Array<number | null> | null>(null);
  const [flagged, setFlagged] = useState<AdvisorApplicationItem[]>([]);
  const [flagsFailed, setFlagsFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.allSettled(cards.map(async ({ paths }) => {
      const results = await Promise.all(paths.map((path) => request<Paginated<unknown>>(`${path}${path.includes('?') ? '&' : '?'}page_size=1`)));
      return results.reduce((count, result) => count + result.meta.total, 0);
    })).then((results) => {
      if (active) setCounts(results.map((result) => result.status === 'fulfilled' ? result.value : null));
    });

    return () => { active = false; };
  }, [request]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const loadPage = (page: number) => request<Paginated<AdvisorApplicationItem>>(
      `/advisor/applications?status=IN_PROGRESS&page_size=${PAGE_SIZE}&page=${page}`,
    );
    const firstPage = loadPage(1);
    // A resize can replace a scan while its next page is still in flight.
    let scan = 0;
    setFlagged([]);
    async function loadFlags() {
      const current = ++scan;
      const found = new Map<string, AdvisorApplicationItem>();
      setFlagsFailed(false);
      try {
        let lastPage = 1;
        for (let page = 1; page <= lastPage; page++) {
          const { data, meta } = await (page === 1 ? firstPage : loadPage(page));
          if (current !== scan) return;
          if (desktop.matches && page === 1) lastPage = Math.ceil(meta.total / meta.page_size);
          const matches = data.filter((app) => app.flagged_for_advisor);
          for (const app of matches) found.set(app.id, app);
          if (page === 1 || matches.length) setFlagged(Array.from(found.values()));
          if (data.length === 0) break;
        }
      } catch {
        if (current === scan && desktop.matches) setFlagsFailed(true);
      }
    }
    void loadFlags();
    desktop.addEventListener('change', loadFlags);
    return () => {
      scan++;
      desktop.removeEventListener('change', loadFlags);
    };
  }, [request, retry]);

  return (
    <main className="bg-surface-muted px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">ภาพรวมอาจารย์</h1>
        <p className="mt-2 text-ink-soft">{user?.full_name}</p>

        {flagged.length > 0 && (
          <section className="mt-6 rounded-xl bg-tile p-6 text-white">
            <h2 className="text-xl font-semibold">การฝึกงานที่มีธงเตือน</h2>
            <ul className="mt-3 space-y-2 text-sm lg:[overflow-wrap:anywhere]">
              {flagged.map((app) => (
                <li key={app.id}>
                  <Link href={`/advisor/students/item?id=${app.student_user_id}`} className="text-primary-on-dark hover:underline">
                    {app.student_name} · {app.company_name} ›
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {flagsFailed && (
          <p role="status" className="mt-4 hidden text-sm text-ink-soft lg:block">
            โหลดข้อมูลการฝึกงานที่มีธงเตือนไม่ครบ{' '}
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => setRetry((value) => value + 1)}>ลองอีกครั้ง</button>
          </p>
        )}

        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ title, href }, index) => (
            <li key={title}>
              <Link href={href} className="block h-full rounded-xl bg-surface p-5 hover:text-primary">
                <span className="block text-4xl font-semibold tabular-nums" aria-label={counts?.[index] === null ? 'โหลดจำนวนไม่สำเร็จ' : undefined}>
                  {counts ? counts[index] ?? '–' : '…'}
                </span>
                <span className="mt-2 block text-sm font-medium">{title} ›</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
