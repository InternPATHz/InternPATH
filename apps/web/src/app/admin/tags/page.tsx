import { Suspense } from 'react';
import { TagsAdmin } from '@/components/admin/tags/tags-admin';

export default function AdminTagsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <TagsAdmin />
    </Suspense>
  );
}
