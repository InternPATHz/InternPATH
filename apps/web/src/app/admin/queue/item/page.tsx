import { Suspense } from 'react';
import { QueueDetail } from '@/components/admin/queue/queue-detail';

// ใช้ query `?id=` แทนเส้นทางไดนามิก เพื่อให้ส่งออกเป็น static ได้ตามแผนสาธิต (README §4.4)
export default function QueueItemPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <QueueDetail />
    </Suspense>
  );
}
