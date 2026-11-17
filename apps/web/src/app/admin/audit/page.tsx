import { Suspense } from 'react';
import { AuditLog } from '@/components/admin/audit/audit-log';

export default function AuditPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <AuditLog />
    </Suspense>
  );
}
