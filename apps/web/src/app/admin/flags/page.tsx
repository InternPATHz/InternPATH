import { Suspense } from 'react';
import { FlagsList } from '@/components/admin/flags/flags-list';

export default function FlagsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <FlagsList />
    </Suspense>
  );
}
