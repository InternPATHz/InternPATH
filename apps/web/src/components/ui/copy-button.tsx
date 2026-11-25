'use client';

import { useEffect, useState } from 'react';

/** สำรองเมื่อไม่มี navigator.clipboard (http ผ่าน IP LAN) หรือเบราว์เซอร์ไม่ให้สิทธิ์ */
function copyWithSelection(value: string): boolean {
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { return document.execCommand('copy'); }
  catch { return false; }
  finally { area.remove(); }
}

/**
 * ปุ่มคัดลอกข้อความสั้น (เช่น รหัสบัญชี) — ผลแจ้งผ่าน aria-live
 * ใช้ navigator.clipboard ก่อน ไม่ได้ค่อยใช้ execCommand('copy')
 */
export function CopyButton({ value, label = 'คัดลอก' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch { setState(copyWithSelection(value) ? 'copied' : 'failed'); }
  }

  return (
    <button type="button" onClick={() => void copy()} aria-label={label} title={label}
      className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs font-medium text-ink-soft hover:bg-surface hover:text-ink">
      <span aria-live="polite">{state === 'copied' ? 'คัดลอกแล้ว' : state === 'failed' ? 'คัดลอกไม่ได้' : 'คัดลอก'}</span>
    </button>
  );
}
