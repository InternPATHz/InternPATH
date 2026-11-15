'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { QueueActionRequest, QueueItemDetail } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { ApiError } from '@/lib/api';
import { HighlightedText } from './highlighted-text';
import { ACTIONS_BY_TYPE, REASON_MAX } from './queue-actions';
import { Badge, ItemBadges, STATUS_LABEL, TYPE_LABEL, formatDateTime, riskStyle } from './queue-ui';

const FIELD_LABEL: Record<string, string> = {
  job_title: 'ตำแหน่ง', description: 'รายละเอียดงาน', responsibilities: 'หน้าที่', qualifications: 'คุณสมบัติ',
  allowance_text: 'ค่าตอบแทน', location: 'สถานที่',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink-soft">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function actionError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return 'รายการนี้ถูกตัดสินไปแล้วหรือสถานะเปลี่ยนไป กรุณากลับไปที่คิวแล้วเปิดรายการใหม่';
    return cause.message;
  }
  return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

export function QueueDetail() {
  const router = useRouter();
  const id = useSearchParams().get('id') ?? '';
  const { request } = useAuth();
  const [item, setItem] = useState<QueueItemDetail | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!id) { setError('ไม่พบรหัสรายการ'); return; }
    let active = true;
    setItem(null);
    setError('');
    request<QueueItemDetail>(`/admin/queue/${encodeURIComponent(id)}`)
      .then((data) => { if (active) setItem(data); })
      .catch((cause) => { if (active) setError(cause instanceof ApiError && cause.status === 404 ? 'ไม่พบรายการนี้' : actionError(cause)); });
    return () => { active = false; };
  }, [id, request]);

  async function decide(action: string, reasonRequired: boolean) {
    const trimmed = reason.trim();
    if (reasonRequired && !trimmed) { setFormError('กรุณากรอกเหตุผลก่อนดำเนินการ'); return; }
    if (trimmed.length > REASON_MAX) { setFormError(`เหตุผลต้องไม่เกิน ${REASON_MAX} ตัวอักษร`); return; }
    setBusy(true);
    setFormError('');
    try {
      const body: QueueActionRequest = trimmed ? { reason: trimmed } : {};
      await request<void>(`/admin/queue/${encodeURIComponent(id)}/actions/${action}`, { method: 'POST', body });
      router.push('/admin/queue');
    } catch (cause) {
      setFormError(actionError(cause));
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div>
        <p role="alert" className="rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-text">{error}</p>
        <Link href="/admin/queue" className="mt-4 inline-block text-sm text-primary hover:underline">← กลับไปคิว</Link>
      </div>
    );
  }
  if (!item) return <p className="text-sm text-ink-soft">กำลังโหลด…</p>;

  const risk = riskStyle(item.risk_level);
  const open = item.status !== 'RESOLVED';
  const actions = ACTIONS_BY_TYPE[item.type] ?? [];
  // เรียงตามลำดับในฟอร์มประกาศ (ฟิลด์ที่ไม่รู้จักไปท้ายสุด) ไม่ใช่ลำดับของฐานข้อมูล
  const fieldOrder = Object.keys(FIELD_LABEL);
  const rank = (field: string) => { const index = fieldOrder.indexOf(field); return index === -1 ? fieldOrder.length : index; };
  const contentFields = item.content ? Object.entries(item.content).sort(([a], [b]) => rank(a) - rank(b)) : [];
  const review = item.review;
  const reviewText = review ? (review.title ? `${review.title}\n${review.body}` : review.body) : '';

  return (
    <div className="space-y-5">
      <Link href="/admin/queue" className="text-sm text-primary hover:underline">← กลับไปคิว</Link>

      <header className={`rounded-xl border border-border border-l-4 bg-surface p-5 ${risk.stripe}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">{TYPE_LABEL[item.type]}</h1>
          <Badge className="bg-surface-muted text-ink-soft">{STATUS_LABEL[item.status]}</Badge>
          <ItemBadges item={item} />
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-ink-soft">บริษัท: </dt><dd className="inline">{item.company_name ?? '—'}</dd></div>
          <div><dt className="inline text-ink-soft">ครบกำหนด: </dt><dd className="inline">{formatDateTime(item.due_at)}</dd></div>
          <div><dt className="inline text-ink-soft">ที่มา: </dt><dd className="inline">{item.origin}</dd></div>
          <div><dt className="inline text-ink-soft">สร้างเมื่อ: </dt><dd className="inline">{formatDateTime(item.created_at)}</dd></div>
          {item.risk_score !== null && <div><dt className="inline text-ink-soft">คะแนนความเสี่ยง: </dt><dd className="inline">{item.risk_score}</dd></div>}
          {!open && <div><dt className="inline text-ink-soft">ผลการตัดสิน: </dt><dd className="inline">{item.resolution ?? '—'} ({formatDateTime(item.resolved_at)})</dd></div>}
        </dl>
      </header>

      {item.appeal_statement && <Section title="คำชี้แจงอุทธรณ์ของ HR"><p className="whitespace-pre-wrap text-sm leading-thai">{item.appeal_statement}</p></Section>}

      {item.reasons.length > 0 && (
        <Section title="เหตุผลที่ระบบประเมิน">
          <ul className="space-y-1.5 text-sm">
            {item.reasons.map((reasonItem, index) => (
              <li key={`${reasonItem.code}-${index}`}>
                <span className="font-mono text-xs text-ink-soft">{reasonItem.code}</span>{' '}
                {reasonItem.detail}
                {reasonItem.matched_text && <> — <mark className="rounded bg-danger-soft px-1 text-danger-text">{reasonItem.matched_text}</mark></>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {item.content === null && item.type.startsWith('JOB_') && item.type !== 'JOB_REPORT' && (
        <Section title="เนื้อหาประกาศ"><p className="text-sm text-ink-soft">ยังไม่มีผลตรวจของรายการนี้ (Fail-safe) จึงไม่มีเนื้อหาให้แสดง</p></Section>
      )}
      {contentFields.length > 0 && (
        <Section title="เนื้อหาประกาศ (ข้อความที่ใช้สแกน)">
          <div className="space-y-4">
            {contentFields.map(([field, text]) => (
              <div key={field}>
                <p className="text-xs font-medium text-ink-soft">{FIELD_LABEL[field] ?? field}</p>
                <HighlightedText text={text} highlights={item.highlights.filter((h) => h.field === field)} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {review && (
        <Section title={`รีวิว · ${review.rating}/5 · ${review.outcome_label}`}>
          <div className="mb-2 flex gap-2"><Badge className="bg-surface-muted text-ink-soft">{review.moderation_status}</Badge></div>
          <HighlightedText text={reviewText} highlights={review.highlights} />
        </Section>
      )}

      {item.reports.length > 0 && (
        <Section title={`รายงานประกาศ (${item.reports.length})`}>
          <ul className="divide-y divide-border text-sm">
            {item.reports.map((report) => (
              <li key={report.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-surface-muted text-ink-soft">{report.category}</Badge>
                  <Badge className={report.counted ? 'bg-danger-soft text-danger-text' : 'bg-surface-muted text-ink-soft'}>{report.counted ? 'นับเข้าเกณฑ์' : 'ไม่นับ'}</Badge>
                  <span className="text-xs text-ink-soft">{report.status} · {formatDateTime(report.created_at)} · ผู้รายงาน {report.reporter_user_id}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{report.detail}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {item.review_reports.length > 0 && (
        <Section title={`รายงานรีวิว (${item.review_reports.length})`}>
          <ul className="divide-y divide-border text-sm">
            {item.review_reports.map((report) => (
              <li key={report.id} className="py-2">
                <p className="text-xs text-ink-soft">{formatDateTime(report.created_at)} · ผู้รายงาน {report.reporter_user_id}</p>
                <p className="mt-1 whitespace-pre-wrap">{report.reason}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {open && actions.length > 0 && (
        <Section title="ตัดสินรายการนี้">
          <label className="block text-sm">
            <span className="font-medium">เหตุผล {actions.some((a) => a.reasonRequired) && <span className="text-xs text-ink-soft">(จำเป็นเมื่อปฏิเสธ/ลบ)</span>}</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={REASON_MAX}
              className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          {formError && <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-text">{formError}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            {actions.map((spec) => (
              <button key={spec.action} type="button" disabled={busy} onClick={() => void decide(spec.action, spec.reasonRequired)}
                className={`rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50 ${spec.tone === 'primary' ? 'bg-primary text-white hover:bg-primary-hover' : spec.tone === 'danger' ? 'bg-danger text-white hover:opacity-90' : 'border border-border text-ink hover:bg-surface-muted'}`}>
                {spec.label}
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
