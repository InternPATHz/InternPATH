import Link from 'next/link';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="text-5xl font-bold text-primary">404</p>
        <h1 className="mt-4 text-xl font-bold">ไม่พบหน้าที่ต้องการ</h1>
        <p className="mt-2 text-sm text-ink-soft">ลิงก์อาจผิด หน้านี้ถูกย้าย หรือยังไม่เปิดให้ใช้งาน</p>
        <Link href="/" className="mt-6 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover">กลับหน้าแรก</Link>
      </main>
      <SiteFooter />
    </div>
  );
}
