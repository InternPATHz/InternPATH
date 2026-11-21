import { Suspense } from 'react';
import { AdminAdvisors } from '@/components/admin/identity/admin-advisors';

export default function AdvisorsPage() {
  return <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}><AdminAdvisors /></Suspense>;
}
