'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { RiskRulesResponse, UpdateRiskRulesRequest } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { BlacklistTestPanel } from '@/components/admin/blacklist/blacklist-test-panel';
import { Notice } from '@/components/admin/filter-fields';
import { Badge } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';
import { RISK_LEVEL_NOTES } from './rule-meta';
import { RuleRow } from './rule-row';
import type { RuleChange } from './rule-row';

const CUE_MAX = 50;

function failure(cause: unknown): string {
  if (cause instanceof ApiError) return cause.status === 400 ? 'ค่าที่กรอกไม่ถูกต้อง ไม่มีรายการใดถูกเปลี่ยน กรุณาตรวจค่าแล้วลองใหม่' : cause.message;
  return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

export function RiskRulesPage() {
  const { request } = useAuth();
  const [data, setData] = useState<RiskRulesResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCue, setNewCue] = useState('');
  const [cueError, setCueError] = useState('');

  const load = useCallback(() => {
    setError('');
    request<RiskRulesResponse>('/admin/risk-rules')
      .then(setData)
      .catch((cause) => setError(failure(cause)));
  }, [request]);

  useEffect(() => { load(); }, [load]);

  /** PUT แล้วใช้ response (ค่าใหม่ทั้งชุด) แทนข้อมูลเดิม — API ตรวจทุกรายการก่อนแก้ ผิดข้อเดียว = ไม่เปลี่ยนเลย */
  async function put(body: UpdateRiskRulesRequest, message: string): Promise<void> {
    setNotice('');
    const response = await request<RiskRulesResponse>('/admin/risk-rules', { method: 'PUT', body });
    setData(response);
    setNotice(message);
  }

  async function saveRule(code: string, change: RuleChange): Promise<void> {
    try { await put({ rules: [{ code, ...change }] }, `บันทึกกฎ ${code} แล้ว`); }
    catch (cause) { throw new Error(failure(cause)); }
  }

  async function toggleCue(cue: string, enabled: boolean) {
    setBusy(true);
    try { await put({ negation_cues: [{ cue, enabled }] }, `${enabled ? 'เปิด' : 'ปิด'}ใช้งานคำปฏิเสธ "${cue}" แล้ว`); }
    catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  }

  async function addCue(event: FormEvent) {
    event.preventDefault();
    const cue = newCue.trim();
    if (!cue) { setCueError('กรุณากรอกคำปฏิเสธ'); return; }
    if (cue.length > CUE_MAX) { setCueError(`คำปฏิเสธต้องไม่เกิน ${CUE_MAX} ตัวอักษร`); return; }
    if (data?.negation_cues.some((item) => item.cue === cue.toLowerCase())) { setCueError('มีคำนี้อยู่ในรายการแล้ว'); return; }
    setBusy(true);
    setCueError('');
    try { await put({ negation_cues: [{ cue, enabled: true }] }, `เพิ่มคำปฏิเสธ "${cue}" แล้ว`); setNewCue(''); }
    catch (cause) { setCueError(failure(cause)); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">กฎคะแนนความเสี่ยง</h1>
        <p className="mt-1 text-sm text-ink-soft">
          ปรับน้ำหนักและเกณฑ์ของกฎที่ใช้คิดคะแนนประกาศงาน มีผลกับประกาศที่ส่งตรวจหลังจากบันทึกเท่านั้น ทุกการแก้ไขถูกบันทึกใน Audit log
        </p>
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {RISK_LEVEL_NOTES.map((note) => (
            <li key={note.label}><Badge className={note.badge}>{note.label}: {note.range}</Badge></li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-ink-soft">เกณฑ์แบ่งระดับด้านบนตายตัวในระบบ แก้ที่หน้านี้ไม่ได้</p>
      </div>

      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}

      {data && (
        <>
          <section aria-labelledby="rules-title" className="space-y-3">
            <h2 id="rules-title" className="text-lg font-semibold">กฎ ({data.rules.length})</h2>
            {data.rules.map((rule) => (
              <RuleRow key={`${rule.code}:${rule.weight}:${rule.enabled}:${JSON.stringify(rule.params)}`} rule={rule} onSave={saveRule} />
            ))}
          </section>

          <section aria-labelledby="cues-title" className="rounded-xl border border-border bg-surface p-4">
            <h2 id="cues-title" className="text-lg font-semibold">คำปฏิเสธ ({data.negation_cues.length})</h2>
            <p className="mt-1 text-sm text-ink-soft">
              คำต้องห้ามที่ตามหลังคำเหล่านี้ (ในระยะที่กำหนดของกฎ "ช่วงตรวจประโยคปฏิเสธ") จะไม่ถูกนับเป็นคำต้องห้าม แต่ประกาศจะเข้าคิวให้ Admin ตรวจ
              ลบคำไม่ได้ ปิดการใช้งานแทนได้
            </p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {data.negation_cues.map((item) => (
                <li key={item.id} className={`flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm ${item.enabled ? '' : 'text-ink-soft line-through'}`}>
                  {item.cue}
                  <button type="button" role="switch" aria-checked={item.enabled} disabled={busy}
                    aria-label={`${item.enabled ? 'ปิด' : 'เปิด'}ใช้งานคำปฏิเสธ ${item.cue}`}
                    onClick={() => void toggleCue(item.cue, !item.enabled)}
                    className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${item.enabled ? 'bg-primary' : 'bg-border'}`}>
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-all ${item.enabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={(event) => void addCue(event)} className="mt-4 flex flex-wrap items-end gap-3">
              <label className="w-64 text-sm">
                <span className="mb-1 block text-xs font-medium text-ink-soft">เพิ่มคำปฏิเสธ</span>
                <input value={newCue} onChange={(event) => setNewCue(event.target.value)} maxLength={CUE_MAX}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
              </label>
              <button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">เพิ่ม</button>
            </form>
            {cueError && <div className="mt-3"><Notice tone="error">{cueError}</Notice></div>}
          </section>

          <BlacklistTestPanel />
        </>
      )}
    </div>
  );
}
