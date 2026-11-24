import Link from 'next/link';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="text-8xl font-semibold leading-none text-border sm:text-9xl">404</p>
        <h1 className="mt-4 text-3xl font-semibold">ไม่พบหน้าที่ต้องการ</h1>
        <p className="mt-2 text-sm text-ink-soft">ลิงก์อาจผิด หรือหน้านี้ถูกย้ายไปแล้ว</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/" className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover">กลับหน้าแรก</Link>
          <Link href="/jobs" className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-primary">ค้นหางาน</Link>
        </div>
        <form action="/jobs" method="get" role="search" className="mt-4 flex w-full items-center gap-2">
          <input type="search" name="q" aria-label="ตำแหน่งหรือบริษัท" placeholder="ตำแหน่งหรือบริษัท" className="min-w-0 flex-1 rounded-full border border-border px-4 py-2" />
          <button type="submit" className="rounded-full px-3 py-2 text-sm font-semibold text-primary">ค้นหา</button>
        </form>
      </main>
      <SiteFooter />
    </div>
  );
}
