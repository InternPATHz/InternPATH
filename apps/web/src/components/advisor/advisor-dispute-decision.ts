'use client';

import { useRef, useState } from 'react';
import type { AdvisorDisputeAction, AdvisorDisputeItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { failure, NOTE_MAX, type Message } from './advisor-ui';

export function useAdvisorDisputeDecision(onChanged: () => void | Promise<void>) {
  const { request } = useAuth();
  const inFlight = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  async function decide(item: AdvisorDisputeItem, action: AdvisorDisputeAction, rawNote: string) {
    if (inFlight.current || (action === 'request-reevaluation' && item.evaluation?.round === 2)) return;
    const reeval = action === 'request-reevaluation';
    const question = reeval
      ? `ให้บริษัทประเมิน ${item.student_name} ใหม่? (ประเมินซ้ำได้ 1 รอบ)`
      : `ยืนยันผลไม่ผ่านของ ${item.student_name}?`;
    if (!window.confirm(question)) return;
    const note = rawNote.trim();
    if (note.length > NOTE_MAX) { setMessage({ tone: 'error', text: `หมายเหตุต้องไม่เกิน ${NOTE_MAX} ตัวอักษร` }); return; }

    inFlight.current = true;
    setBusyId(item.id);
    setMessage(null);
    try {
      await request(`/advisor/applications/${encodeURIComponent(item.id)}/actions/${action}`, { method: 'POST', body: note ? { note } : {} });
      setMessage({
        tone: 'success',
        text: reeval ? `ส่งให้บริษัทประเมิน ${item.student_name} ใหม่แล้ว` : `ยืนยันผลไม่ผ่านของ ${item.student_name} แล้ว`,
      });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
    } finally {
      try { await onChanged(); }
      finally {
        inFlight.current = false;
        setBusyId(null);
      }
    }
  }

  return { busyId, decide, message };
}
