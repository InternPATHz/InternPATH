'use client';

import Link from 'next/link';

/** ขอบเขตข้อผิดพลาดของทั้งแอป: ไม่แสดงรายละเอียดของข้อผิดพลาดให้ผู้ใช้ (อาจมีข้อมูลภายใน) */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold">เกิดข้อผิดพลาดบางอย่าง</h1>
      <p className="mt-2 text-sm text-ink-soft">กรุณาลองใหม่อีกครั้ง หากยังเกิดซ้ำ ให้กลับหน้าแรกแล้วเริ่มใหม่</p>
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={reset} className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover">ลองใหม่</button>
        <Link href="/" className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted">กลับหน้าแรก</Link>
      </div>
    </main>
  );
}
