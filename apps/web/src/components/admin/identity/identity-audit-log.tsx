'use client';

import { useEffect, useState } from 'react';
import type { Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';

type AuditEntry = {
  id: string;
  admin_id: string;
  action: string;
  target_type: string;
  target_id: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  correlation_id: string;
  occurred_at: string;
};

const PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function JsonValue({ label, value }: { label: string; value: unknown }) {
  return <div className="min-w-0 flex-1">
    <p className="text-xs font-medium text-ink-soft">{label}</p>
    <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-surface-muted p-3 text-xs">
      {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
    </pre>
  </div>;
}

export function IdentityAuditLog() {
  const { request } = useAuth();
  const [actionText, setActionText] = useState('');
  const [action, setAction] = useState('');
  const [targetTypeText, setTargetTypeText] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetIdText, setTargetIdText] = useState('');
  const [targetId, setTargetId] = useState('');
  const [adminIdText, setAdminIdText] = useState('');
  const [adminId, setAdminId] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<AuditEntry> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (action) query.set('action', action);
    if (targetType) query.set('target_type', targetType);
    if (targetId) query.set('target_id', targetId);
    if (adminId) query.set('admin_id', adminId);
    setLoading(true);
    setError('');
    request<Paginated<AuditEntry>>(`/admin/audit-logs?${query}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) { setResult(null); setError(cause instanceof Error ? cause.message : 'โหลด Audit log ไม่สำเร็จ'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, action, targetType, targetId, adminId, page]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTargetId = targetIdText.trim();
    const nextAdminId = adminIdText.trim();
    if ((nextTargetId && !UUID.test(nextTargetId)) || (nextAdminId && !UUID.test(nextAdminId))) {
      setError('รหัสเป้าหมายและรหัสผู้ดูแลต้องเป็น UUID');
      return;
    }
    setError('');
    setAction(actionText.trim());
    setTargetType(targetTypeText.trim());
    setTargetId(nextTargetId);
    setAdminId(nextAdminId);
    setPage(1);
  }

  const lastPage = Math.max(1, Math.ceil((result?.meta.total ?? 0) / PAGE_SIZE));
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">Audit log ของ Identity</h1>
      <p className="mt-1 text-sm text-ink-soft">ดูการเปลี่ยนแปลงบัญชี อาจารย์ และบริษัท โดยเรียงรายการใหม่ก่อน</p></div>
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5">
      {[
        { label: 'การกระทำ', value: actionText, set: setActionText, max: 100 },
        { label: 'ชนิดเป้าหมาย', value: targetTypeText, set: setTargetTypeText, max: 50 },
        { label: 'รหัสเป้าหมาย', value: targetIdText, set: setTargetIdText, max: 36 },
        { label: 'รหัสผู้ดูแล', value: adminIdText, set: setAdminIdText, max: 36 },
      ].map((field) => <label key={field.label} className="text-sm">{field.label}
        <input value={field.value} onChange={(event) => field.set(event.target.value)} maxLength={field.max}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
      </label>)}
      <button className="self-end rounded-lg bg-primary px-4 py-2 font-medium text-white hover:bg-primary-hover">กรอง</button>
    </form>
    {error && <Notice tone="error">{error}</Notice>}
    <section aria-busy={loading} className="rounded-xl border border-border bg-surface p-4">
      {loading ? <p className="text-sm text-ink-soft">กำลังโหลด…</p> : !result?.data.length ?
        <p className="text-sm text-ink-soft">ไม่พบรายการที่ตรงกับตัวกรอง</p> :
        <div className="divide-y divide-border">{result.data.map((entry) => <article key={entry.id} className="py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1">
            <p className="font-medium">{entry.action} <span className="text-sm font-normal text-ink-soft">· {entry.target_type}</span></p>
            <p className="break-all text-xs text-ink-soft">เป้าหมาย {entry.target_id} · ผู้ดูแล {entry.admin_id}</p>
            <p className="text-xs text-ink-soft">{new Date(entry.occurred_at).toLocaleString('th-TH')} · Correlation ID {entry.correlation_id}</p>
            {entry.reason && <p className="text-sm">เหตุผล: {entry.reason}</p>}
          </div><button type="button" onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
            aria-expanded={openId === entry.id} className="rounded-lg border border-border px-3 py-2 text-sm">{openId === entry.id ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียด'}</button></div>
          {openId === entry.id && <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <JsonValue label="ก่อนเปลี่ยน" value={entry.before} /><JsonValue label="หลังเปลี่ยน" value={entry.after} />
          </div>}
        </article>)}</div>}
      <nav aria-label="เลือกหน้า Audit log" className="mt-4 flex items-center justify-end gap-3 text-sm">
        <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40">ก่อนหน้า</button>
        <span>{page} / {lastPage}</span>
        <button type="button" disabled={page >= lastPage} onClick={() => setPage(page + 1)} className="disabled:opacity-40">ถัดไป</button>
      </nav>
    </section>
  </div>;
}
