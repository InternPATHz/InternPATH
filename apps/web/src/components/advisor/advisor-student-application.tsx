'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AdvisorDisputeAction, AdvisorDisputeItem, ApplicationBase, ApplicationStatus } from '@internpath/contracts';
import { ApplicationStatusBadge, formatDate, formatDateTime } from '@/components/student/application-ui';
import { APPLICATION_STATUS, statusView } from '@/lib/status-map';
import { inputClass, NOTE_MAX, primaryButton, secondaryButton } from './advisor-ui';

const steps = ['สมัคร', 'อาจารย์อนุมัติ', 'ฝึกงาน', 'บริษัทประเมิน', 'อาจารย์ตัดสิน', 'เสร็จสิ้น'];
const stage: Partial<Record<ApplicationStatus, number>> = {
  PENDING: 0, HR_ACCEPTED: 0, ADVISOR_PENDING: 1, ADVISOR_APPROVED: 1, IN_PROGRESS: 2,
  EVALUATED_PASS: 3, EVALUATED_FAIL: 3, FAIL_DISPUTED: 4, REEVALUATION_REQUESTED: 4, COMPLETED: 5, NO_EVALUATION: 3,
};

export function AdvisorStudentApplication({ app, dispute, loadingDispute, disputesFailed, busy, onDecide }: {
  app: ApplicationBase;
  dispute?: AdvisorDisputeItem;
  loadingDispute: boolean;
  disputesFailed: boolean;
  busy: boolean;
  onDecide: (item: AdvisorDisputeItem, action: AdvisorDisputeAction, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const current = stage[app.status];
  const start = app.actual_start_date ?? app.start_date;
  const end = app.actual_end_date ?? app.end_date;
  const history = [{ label: 'ส่งใบสมัคร', date: app.created_at, dateOnly: false }];
  if (app.actual_start_date) history.push({ label: 'เริ่มฝึกงานจริง', date: app.actual_start_date, dateOnly: true });
  if (app.actual_end_date) history.push({ label: 'สิ้นสุดการฝึกงานจริง', date: app.actual_end_date, dateOnly: true });
  if (dispute?.evaluation) history.push({ label: dispute.evaluation.result === 'FAIL' ? 'บริษัทประเมินไม่ผ่าน' : 'บริษัทประเมินผ่าน', date: dispute.evaluation.evaluated_at, dateOnly: false });
  if (dispute) history.push({ label: 'นักศึกษาส่งคำโต้แย้ง', date: dispute.dispute.created_at, dateOnly: false });
  else if (app.status !== 'PENDING' || app.status_changed_at !== app.created_at) {
    history.push({ label: `สถานะล่าสุด · ${statusView(APPLICATION_STATUS, app.status).label}`, date: app.status_changed_at, dateOnly: false });
  }
  history.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  return (
    <li className="rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h3 className="text-lg font-semibold">{app.job_title}</h3>
          <p className="text-sm text-ink-soft">{app.company_name}</p>
        </div>
        <ApplicationStatusBadge status={app.status} academicResult={dispute?.academic_result} />
      </div>

      {current !== undefined && (
        <ol aria-label="ความคืบหน้าการฝึกงาน" className="mt-4 grid grid-cols-3 gap-y-4 rounded-xl bg-surface-muted p-4 text-center text-xs sm:grid-cols-6">
          {steps.map((label, index) => (
            <li key={label} aria-current={index === current ? 'step' : undefined}
              className={index <= current ? 'font-semibold text-ink' : 'text-ink-soft'}>
              <span aria-hidden="true" className="relative mb-1.5 block">
                <span className="absolute inset-x-0 top-1/2 border-t border-border" />
                <span className={`relative mx-auto block h-3 w-3 rounded-full border-2 ${index === current ? 'border-ink bg-surface' : index < current ? 'border-ink bg-ink' : 'border-border bg-surface'}`} />
              </span>
              {label}
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
          {dispute && (
            <>
              <section className="rounded-xl bg-tile p-5 text-white">
                <h4 className="text-lg font-semibold">นักศึกษาโต้แย้งผลประเมินไม่ผ่าน</h4>
                <p className="mt-2 text-sm text-white/80">ขอให้บริษัทประเมินใหม่ได้หนึ่งรอบ หรือยืนตามผลเดิม</p>
                <label className="mt-4 block text-sm font-medium">
                  หมายเหตุถึงบริษัทและนักศึกษา (ไม่บังคับ)
                  <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={NOTE_MAX} rows={2} className={`${inputClass} text-ink`} />
                </label>
                <div className="mt-4 flex flex-wrap gap-2">
                  {dispute.evaluation?.round === 1 && (
                    <button type="button" disabled={busy} onClick={() => void onDecide(dispute, 'request-reevaluation', note)} className={primaryButton}>ให้บริษัทประเมินใหม่</button>
                  )}
                  <button type="button" disabled={busy} onClick={() => void onDecide(dispute, 'uphold-fail', note)}
                    className={`${secondaryButton} border-white/40 hover:bg-white/10`}>ยืนตามผลเดิม</button>
                </div>
              </section>
              <section className="rounded-xl border border-border p-4">
                <h4 className="font-semibold">เหตุผลที่บริษัทประเมินไม่ผ่าน</h4>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{dispute.evaluation?.reason ?? 'ไม่มีข้อมูลเหตุผลจากบริษัท'}</p>
              </section>
              <section className="rounded-xl border border-border p-4">
                <h4 className="font-semibold">คำโต้แย้งของนักศึกษา</h4>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{dispute.dispute.statement}</p>
              </section>
            </>
          )}
          {app.status === 'FAIL_DISPUTED' && !dispute && (
            <p role="status" className="text-sm text-ink-soft">{loadingDispute ? 'กำลังโหลดคำโต้แย้ง…' : disputesFailed ? 'โหลดคำโต้แย้งไม่สำเร็จ' : 'ไม่มีคำโต้แย้งที่รอตัดสินสำหรับใบสมัครนี้'}</p>
          )}
          <section className="rounded-xl bg-surface-muted p-4 text-sm">
            <h4 className="font-semibold">ข้อมูลการฝึก</h4>
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              <div><dt className="text-xs text-ink-soft">อัปเดตล่าสุด</dt><dd>{formatDate(app.status_changed_at)}</dd></div>
              {start && <div><dt className="text-xs text-ink-soft">เริ่มฝึก</dt><dd>{formatDate(start)}</dd></div>}
              {end && <div><dt className="text-xs text-ink-soft">สิ้นสุดการฝึก</dt><dd>{formatDate(end)}</dd></div>}
            </dl>
            {app.major_mismatch && <p className="mt-3 text-warning-text">สาขาไม่ตรงกับที่ประกาศระบุ</p>}
            {app.frozen && <p className="mt-3 text-warning-text">ประกาศถูกระงับชั่วคราว</p>}
            {app.status === 'ADVISOR_PENDING' && (
              <Link href="/advisor/approvals" className="mt-3 inline-block font-medium text-primary hover:underline">เปิดคิวอนุมัติ ›</Link>
            )}
            {['FAIL_DISPUTED', 'EVALUATED_PASS', 'EVALUATED_FAIL', 'NO_EVALUATION'].includes(app.status) && (
              <Link href="/advisor/evaluations" className="mt-3 inline-block font-medium text-primary hover:underline">เปิดหน้าประเมินผล ›</Link>
            )}
          </section>
        </div>

        <aside aria-label="ประวัติใบสมัคร" className="rounded-xl border border-border p-4">
          <h4 className="font-semibold">ประวัติ</h4>
          <ol className="mt-3 space-y-3 border-l border-border pl-4 text-sm">
            {history.map(({ label, date, dateOnly }) => (
              <li key={label}>
                <p className="font-medium">{label}</p>
                <time dateTime={date} className="text-xs text-ink-soft">{dateOnly ? formatDate(date) : formatDateTime(date)}</time>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </li>
  );
}
