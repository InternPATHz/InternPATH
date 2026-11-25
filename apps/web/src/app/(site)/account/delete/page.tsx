'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DeleteAccount } from '@/components/account/delete-account';
import { RequireAuth } from '@/components/layout/require-auth';

export default function DeleteAccountPage() {
  const [deleted, setDeleted] = useState(false);
  if (deleted) return <main className="mx-auto max-w-lg px-4 py-16 text-center">
    <h1 className="text-2xl font-semibold">ลบบัญชีเรียบร้อยแล้ว</h1>
    <p className="mt-3 text-sm text-ink-soft">ออกจากระบบแล้ว ระบบจะจัดการข้อมูลที่เกี่ยวข้องตามนโยบายความเป็นส่วนตัว</p>
    <Link href="/" className="mt-6 inline-block text-primary">กลับหน้าแรก</Link>
  </main>;
  return (
    <RequireAuth>
      <DeleteAccount onDeleted={() => setDeleted(true)} />
    </RequireAuth>
  );
}
