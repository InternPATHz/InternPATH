'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { QueueTotal, type QueueMetric } from '@/components/dashboard/queue-total';
import { CATEGORIES } from '@/lib/categories';
import { Avatar } from '@/components/ui/avatar';
import { StatusBadge } from '@/components/ui/status-badge';
import { COMPANY_STATUS } from '@/lib/status-map';

const groups: { title: string; metrics: QueueMetric[] }[] = [
  {
    title: 'งานที่รอดำเนินการ',
    metrics: [
      {
        title: 'ใบสมัครรอพิจารณา',
        linkLabel: 'เปิดคิวผู้สมัคร',
        tone: 'info',
        paths: ['/hr/applications?status=PENDING'],
        href: '/hr/applicants?status=PENDING',
      },
      {
        title: 'รอยืนยันเริ่มงาน',
        linkLabel: 'ดูรายการรอเริ่มงาน',
        paths: ['/hr/applications?status=ADVISOR_APPROVED'],
        href: '/hr/applicants?status=ADVISOR_APPROVED',
      },
      {
        title: 'ประกาศถูกตีกลับ',
        linkLabel: 'ดูประกาศที่ถูกตีกลับ',
        tone: 'danger',
        paths: ['/hr/jobs?status=ADMIN_REJECTED'],
        href: '/hr/jobs?status=ADMIN_REJECTED',
      },
    ],
  },
  {
    title: 'ประกาศและการฝึกงาน',
    metrics: [
      {
        title: 'ประกาศที่เปิดรับ',
        linkLabel: 'ดูประกาศที่เผยแพร่',
        paths: ['/hr/jobs?status=PUBLISHED'],
        href: '/hr/jobs?status=PUBLISHED',
      },
      {
        title: 'ประกาศร่าง',
        linkLabel: 'ดูร่างประกาศ',
        paths: ['/hr/jobs?status=DRAFT'],
        href: '/hr/jobs?status=DRAFT',
      },
      {
        title: 'ใบสมัครที่อยู่ระหว่างฝึก',
        linkLabel: 'ดูใบสมัครที่กำลังฝึก',
        paths: ['/hr/applications?status=IN_PROGRESS'],
        href: '/hr/applicants?status=IN_PROGRESS',
      },
    ],
  },
];

export function HrOverview() {
  const { request } = useAuth();
  const [me, setMe] = useState<UserMeResponse | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    request<UserMeResponse>('/users/me').then(
      (data) => {
        if (active) setMe(data);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [request, retry]);
  const company = me?.company;
  return (
    <main className="min-h-[65vh] bg-surface-muted px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-[66rem] [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">ภาพรวม HR</h1>
          {company?.status === 'VERIFIED' && (
            <Link
              className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white"
              href="/hr/jobs/form"
            >
              สร้างประกาศใหม่
            </Link>
          )}
        </div>
        {error && (
          <button className="mt-3 text-primary" onClick={() => setRetry((r) => r + 1)}>
            โหลดข้อมูลบัญชีอีกครั้ง
          </button>
        )}
        {company && (
          <header className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-4">
            <Avatar name={company.name} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{company.name}</h2>
                <StatusBadge tone={COMPANY_STATUS[company.status].tone}>
                  {COMPANY_STATUS[company.status].label}
                </StatusBadge>
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                {company.member_role === 'OWNER'
                  ? 'เจ้าของบัญชีบริษัท · เห็นทุกสายงาน'
                  : `สมาชิก HR · ${company.categories?.map((code) => CATEGORIES.find((entry) => entry.id === code)?.label ?? code).join(', ') || 'ยังไม่ระบุสายงาน'}`}
              </p>
            </div>
            <Link
              className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-primary"
              href="/hr/company"
            >
              {company.status === 'VERIFIED' ? 'ดูข้อมูลบริษัท' : 'ดูสถานะบริษัท'} ›
            </Link>
          </header>
        )}
        {groups.map((group) => (
          <section key={group.title} className="mt-5">
            <h2 className="text-lg font-semibold">{group.title}</h2>
            <ul className="mt-2 grid gap-3 sm:grid-cols-3">
              {group.metrics.map((metric) => (
                <QueueTotal key={metric.href} metric={metric} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
