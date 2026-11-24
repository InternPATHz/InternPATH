'use client';

import Link from 'next/link';
import { SiteHeader } from '@/components/layout/site-header';

/** ขอบเขตข้อผิดพลาดของทั้งแอป: ไม่แสดงรายละเอียดของข้อผิดพลาดให้ผู้ใช้ (อาจมีข้อมูลภายใน) */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col">
    <SiteHeader />
    <main className="flex flex-1 flex-col items-center justify-center bg-tile px-4 py-16 text-center text-white">
      <h1 className="text-3xl font-semibold">เกิดข้อผิดพลาดบางอย่าง</h1>
      <p className="mt-2 text-sm text-white/75">กรุณาลองใหม่อีกครั้ง หากยังเกิดซ้ำ ให้กลับหน้าแรกแล้วเริ่มใหม่</p>
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={reset} className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover">ลองใหม่</button>
        <Link href="/" className="px-5 py-2.5 text-sm font-semibold text-primary-on-dark hover:underline">กลับหน้าแรก</Link>
      </div>
    </main>
    </div>
  );
}
