import { Suspense } from 'react';
import { QueueList } from '@/components/admin/queue/queue-list';

export default function QueuePage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <QueueList />
    </Suspense>
  );
}
