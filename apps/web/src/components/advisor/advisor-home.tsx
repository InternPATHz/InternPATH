'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { AdvisorApplicationItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';

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

  useEffect(() => {
    let active = true;
    void Promise.allSettled(cards.map(async ({ paths }) => {
      const results = await Promise.all(paths.map((path) => request<Paginated<unknown>>(`${path}${path.includes('?') ? '&' : '?'}page_size=1`)));
      return results.reduce((count, result) => count + result.meta.total, 0);
    })).then((results) => {
      if (active) setCounts(results.map((result) => result.status === 'fulfilled' ? result.value : null));
    });

    void request<Paginated<AdvisorApplicationItem>>('/advisor/applications?status=IN_PROGRESS&page_size=20')
      .then(({ data }) => { if (active) setFlagged(data.filter((app) => app.flagged_for_advisor)); }, () => undefined);
    return () => { active = false; };
  }, [request]);

  return (
    <main className="bg-surface-muted px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-semibold">ภาพรวมอาจารย์</h1>
        <p className="mt-2 text-ink-soft">{user?.full_name}</p>

        {flagged.length > 0 && (
          <section className="mt-6 rounded-xl bg-tile p-6 text-white">
            <h2 className="text-xl font-semibold">การฝึกงานที่มีธงเตือน</h2>
            <ul className="mt-3 space-y-2 text-sm">
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
