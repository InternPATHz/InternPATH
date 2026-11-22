'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AdminApplicationActionResponse, ApplicationStatus, NoEvaluationCandidate, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ApplicationActions } from '@/components/admin/lifecycle/application-actions';
import { LIFECYCLE_REASON_MAX, ReasonField } from '@/components/admin/lifecycle/reason-field';
import { ApplicationStatusBadge, formatDate } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 20;

/** สถานะต้นทางของ `NO_EVALUATION` (Lifecycle `NO_EVALUATION_SOURCE_STATUSES`) พร้อมความหมายของ "วันฐาน" ที่นับ 14 วัน */
const SOURCE_STATUSES: Array<[ApplicationStatus | '', string]> = [
  ['', 'ทุกสถานะ'],
  ['IN_PROGRESS', 'กำลังฝึกงาน (นับจากวันสิ้นสุดฝึก)'],
  ['TERMINATED', 'ยุติกลางคัน (นับจากวันสิ้นสุดจริง)'],
  ['REEVALUATION_REQUESTED', 'รอ HR ประเมินใหม่ (นับจากวันที่ขอ)'],
];
const SOURCE_VALUES = SOURCE_STATUSES.map(([value]) => value).filter(Boolean);

const dateOrDash = (iso?: string) => (iso ? formatDate(iso) : '—');

type Filters = { status: string; page: number };

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page'));
  const status = params.get('status') ?? '';
  return {
    status: SOURCE_VALUES.includes(status as ApplicationStatus) ? status : '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.toString();
}

function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
  if (cause.issues.includes('EVALUATION_NOT_OVERDUE')) return 'ใบสมัครนี้ยังไม่ครบ 14 วันหลังวันฐาน จึงยังยืนยันไม่ได้ โหลดรายการใหม่ให้แล้ว';
  if (cause.code === 'STATE_CONFLICT') return 'สถานะของใบสมัครเปลี่ยนไปแล้ว (เช่น HR เพิ่งประเมิน) โหลดรายการใหม่ให้แล้ว';
  if (cause.status === 404) return 'ไม่พบใบสมัครนี้แล้ว โหลดรายการใหม่ให้แล้ว';
  return cause.message;
}

/**
 * ใบสมัครที่ HR ไม่ประเมินเกิน 14 วัน (README §5.2.2, UAT-22) — `GET /admin/lifecycle/no-evaluation-candidates`
 * ทุกแถวผ่านเงื่อนไขเดียวกับ Guard ของ `confirm-no-evaluation` แล้ว จึงกดยืนยัน → `NO_EVALUATION` ได้
 * (`reason` ไม่บังคับ — บันทึกผลการติดตามบริษัทใน audit log ของ Lifecycle)
 */
export function NoEvaluationList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const filters = readFilters(new URLSearchParams(searchParams.toString()));
  const queryString = toQuery(filters);

  const [result, setResult] = useState<Paginated<NoEvaluationCandidate> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const apiQuery = new URLSearchParams(queryString);
    apiQuery.set('page_size', String(PAGE_SIZE));
    request<Paginated<NoEvaluationCandidate>>(`/admin/lifecycle/no-evaluation-candidates?${apiQuery.toString()}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) { setResult(null); setError(failure(cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [queryString, reloadKey, request]);

  // มาจากลิงก์ "ยุติการฝึกงาน" ของหน้ารายงานปัญหา (`?terminate=`) — เลื่อนไปที่ฟอร์มหลังรายการโหลดเสร็จ
  // (`#application-actions` ใน URL เลื่อนก่อนรายการโหลด ตำแหน่งจึงคลาด) ทำครั้งเดียวต่อรหัส
  const terminateId = searchParams.get('terminate');
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !terminateId || scrolledFor.current === terminateId) return;
    scrolledFor.current = terminateId;
    document.getElementById('application-actions')?.scrollIntoView({ block: 'start' });
  }, [loading, terminateId]);

  const update = useCallback((patch: Partial<Filters>) => {
    const query = toQuery({ ...filters, page: 1, ...patch });
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [filters, pathname, router]);

  function toggle(id: string) {
    setOpenId(openId === id ? null : id);
    setReason('');
    setFormError('');
    setActionError('');
  }

  async function confirm(event: FormEvent, item: NoEvaluationCandidate) {
    event.preventDefault();
    const text = reason.trim();
    if (text.length > LIFECYCLE_REASON_MAX) { setFormError(`ข้อความต้องไม่เกิน ${LIFECYCLE_REASON_MAX} ตัวอักษร`); return; }
    setBusy(true);
    setFormError('');
    setActionError('');
    setNotice('');
    try {
      await request<AdminApplicationActionResponse>(
        `/admin/lifecycle/applications/${encodeURIComponent(item.id)}/actions/confirm-no-evaluation`,
        { method: 'POST', body: text ? { reason: text } : {} },
      );
      setOpenId(null);
      setReason('');
      setNotice(`ยืนยัน "บริษัทไม่ประเมิน" ของใบสมัคร ${item.job_title || 'ไม่ทราบตำแหน่ง'} (${item.company_name || 'ไม่ทราบชื่อบริษัท'}) แล้ว อาจารย์ที่ปรึกษาบันทึกผลวิชาต่อได้`);
      setReloadKey((key) => key + 1);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.code === 'STATE_CONFLICT' || cause.status === 404)) {
        // แถวอาจหายไปหลังโหลดใหม่ ⇒ แสดงข้อความระดับหน้า ไม่ใช่ในฟอร์มของแถว
        setOpenId(null);
        setActionError(failure(cause));
        setReloadKey((key) => key + 1);
      } else {
        setFormError(failure(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="text-2xl font-semibold">ใบสมัครที่บริษัทไม่ประเมินผล</h1>
      <p className="mt-1 text-sm text-ink-soft">
        ใบสมัครที่ HR ไม่ประเมินเกิน 14 วัน ควรติดตามบริษัทก่อน ถ้ายังไม่ประเมินให้ยืนยัน &quot;บริษัทไม่ประเมิน&quot; เพื่อให้อาจารย์ที่ปรึกษาบันทึกผลวิชาได้ ยืนยันแล้วย้อนกลับไม่ได้
      </p>

      <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="สถานะ" value={filters.status} onChange={(status) => update({ status })} options={SOURCE_STATUSES} />
      </div>

      {notice && <div className="mt-4"><Notice tone="success">{notice}</Notice></div>}
      {actionError && <div className="mt-4"><Notice tone="error">{actionError}</Notice></div>}
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">ตำแหน่ง / บริษัท</th>
              <th scope="col" className="px-4 py-3 font-medium">สถานะ</th>
              <th scope="col" className="px-4 py-3 font-medium">ช่วงฝึก</th>
              <th scope="col" className="px-4 py-3 font-medium">ค้างประเมิน</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">การดำเนินการ</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !result && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && result && result.data.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">ไม่มีใบสมัครที่ค้างประเมินเกิน 14 วัน</td></tr>
            )}
            {result?.data.map((item) => (
              <Fragment key={item.id}>
                <tr className="border-t border-border align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium">{item.job_title || 'ไม่ทราบตำแหน่ง'}</p>
                    <p className="text-ink-soft">{item.company_name || 'ไม่ทราบชื่อบริษัท'}</p>
                    <p className="font-mono text-xs text-ink-soft">{item.id}</p>
                  </td>
                  <td className="px-4 py-3"><ApplicationStatusBadge status={item.status} /></td>
                  <td className="px-4 py-3 text-xs text-ink-soft whitespace-nowrap">
                    <p>{dateOrDash(item.actual_start_date ?? item.start_date)} – {dateOrDash(item.actual_end_date ?? item.end_date)}</p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-medium">{item.days_since_end} วัน</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => toggle(item.id)} aria-expanded={openId === item.id}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">
                      ยืนยันบริษัทไม่ประเมิน
                    </button>
                  </td>
                </tr>
                {openId === item.id && (
                  <tr className="bg-surface-muted">
                    <td colSpan={5} className="px-4 py-4">
                      <form onSubmit={(event) => void confirm(event, item)} noValidate className="max-w-xl">
                        <ReasonField label="ผลการติดตามบริษัท" value={reason} onChange={setReason} />
                        {formError && <div className="mt-2"><Notice tone="error">{formError}</Notice></div>}
                        <div className="mt-3 flex gap-2">
                          <button type="submit" disabled={busy} className="rounded-full bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
                            {busy ? 'กำลังบันทึก…' : 'ยืนยัน (ย้อนกลับไม่ได้)'}
                          </button>
                          <button type="button" onClick={() => setOpenId(null)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface">ยกเลิก</button>
                        </div>
                      </form>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {result && total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
          <span>ทั้งหมด {total} รายการ · หน้า {filters.page} จาก {lastPage}</span>
          <span className="flex gap-2">
            <button type="button" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ก่อนหน้า</button>
            <button type="button" disabled={filters.page >= lastPage} onClick={() => update({ page: filters.page + 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ถัดไป</button>
          </span>
        </div>
      )}

      <ApplicationActions onChanged={() => setReloadKey((key) => key + 1)} />
    </div>
  );
}
