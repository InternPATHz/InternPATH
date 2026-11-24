import { Suspense } from 'react';
import { LifecycleAuditLog } from '@/components/admin/lifecycle/lifecycle-audit-log';

export const metadata = { title: 'Audit log ของ Lifecycle' };

// `useSearchParams` ต้องอยู่ใน Suspense เพื่อให้หน้าสร้างแบบ static ได้
export default function AdminLifecycleAuditPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <LifecycleAuditLog />
    </Suspense>
  );
}
