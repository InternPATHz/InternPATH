import { Suspense } from 'react';
import { BlacklistList } from '@/components/admin/blacklist/blacklist-list';

export default function BlacklistPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <BlacklistList />
    </Suspense>
  );
}
