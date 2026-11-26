import { Suspense } from 'react';
import { AdminUniversities } from '@/components/admin/identity/admin-universities';

export default function UniversitiesPage() {
  return <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}><AdminUniversities /></Suspense>;
}
