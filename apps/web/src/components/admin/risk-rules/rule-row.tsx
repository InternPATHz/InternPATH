'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import type { RiskRule } from '@internpath/contracts';
import { Notice } from '@/components/admin/filter-fields';
import { Badge } from '@/components/admin/queue/queue-ui';
import { RULE_META } from './rule-meta';
import type { ParamMeta } from './rule-meta';

export type RuleChange = { weight?: number; enabled?: boolean; params?: Record<string, number> };

const INT = /^\d+$/;

/** แก้กฎหนึ่งข้อ: ส่งเฉพาะฟิลด์ที่เปลี่ยน (params รวมเข้ากับค่าเดิมที่ฝั่ง Verification) */
export function RuleRow({ rule, onSave }: { rule: RiskRule; onSave: (code: string, change: RuleChange) => Promise<void> }) {
  const meta = RULE_META[rule.code];
  // พารามิเตอร์ที่ไม่รู้จักยังแก้ได้ในรูปแบบทั่วไป
  const knownKeys = new Set((meta?.params ?? []).map((param) => param.key));
  const params: ParamMeta[] = [
    ...(meta?.params ?? []),
    ...Object.keys(rule.params).filter((key) => !knownKeys.has(key)).map((key): ParamMeta => ({ key, label: key, min: 0 })),
  ];

  const initial = () => ({
    weight: String(rule.weight),
    enabled: rule.enabled,
    params: Object.fromEntries(params.map((param) => [param.key, String(rule.params[param.key] ?? '')])) as Record<string, string>,
  });
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dirty = draft.weight !== String(rule.weight) || draft.enabled !== rule.enabled
    || params.some((param) => draft.params[param.key] !== String(rule.params[param.key] ?? ''));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const change: RuleChange = {};
    if (draft.weight !== String(rule.weight)) {
      if (!INT.test(draft.weight.trim())) { setError('น้ำหนักต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป'); return; }
      change.weight = Number(draft.weight);
    }
    if (draft.enabled !== rule.enabled) change.enabled = draft.enabled;
    for (const param of params) {
      const raw = draft.params[param.key].trim();
      if (raw === String(rule.params[param.key] ?? '')) continue;
      const value = Number(raw);
      if (raw === '' || !Number.isFinite(value)) { setError(`"${param.label}" ต้องเป็นตัวเลข`); return; }
      if (param.min !== undefined && value < param.min) { setError(`"${param.label}" ต้องไม่น้อยกว่า ${param.min}`); return; }
      if (param.max !== undefined && value > param.max) { setError(`"${param.label}" ต้องไม่เกิน ${param.max}`); return; }
      (change.params ??= {})[param.key] = value;
    }
    setError('');
    setBusy(true);
    try { await onSave(rule.code, change); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'บันทึกไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className={`rounded-xl border border-border bg-surface p-4 ${rule.enabled ? '' : 'opacity-80'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{meta?.name ?? rule.code}</h3>
            <Badge className="bg-surface-muted text-ink-soft"><span className="font-mono">{rule.code}</span></Badge>
            {!rule.enabled && <Badge className="bg-surface-muted text-ink-soft">ปิดอยู่</Badge>}
          </div>
          {meta && <p className="mt-1 text-sm text-ink-soft">{meta.description}</p>}
        </div>
        <button type="button" role="switch" aria-checked={draft.enabled} aria-label={`${draft.enabled ? 'ปิด' : 'เปิด'}ใช้งานกฎ ${meta?.name ?? rule.code}`}
          onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${draft.enabled ? 'bg-primary' : 'bg-border'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${draft.enabled ? 'left-[1.375rem]' : 'left-0.5'}`} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="w-32 text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-soft">{meta?.weightHint ? `น้ำหนัก (${meta.weightHint})` : 'น้ำหนักคะแนน'}</span>
          <input value={draft.weight} inputMode="numeric" onChange={(event) => setDraft((current) => ({ ...current, weight: event.target.value }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
        </label>
        {params.map((param) => (
          <label key={param.key} className="w-44 text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">{param.label}{param.unit ? ` (${param.unit})` : ''}</span>
            <input value={draft.params[param.key]} inputMode="numeric"
              onChange={(event) => setDraft((current) => ({ ...current, params: { ...current.params, [param.key]: event.target.value } }))}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
        ))}
        <button type="submit" disabled={!dirty || busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-40">
          {busy ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
        {dirty && !busy && (
          <button type="button" onClick={() => { setDraft(initial()); setError(''); }} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-muted">คืนค่าเดิม</button>
        )}
      </div>
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
    </form>
  );
}
