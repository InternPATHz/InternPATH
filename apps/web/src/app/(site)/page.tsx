import Link from 'next/link';
import { CategorySection } from '@/components/landing/category-section';
import { Hero } from '@/components/landing/hero';
import { FeaturedJobs } from '@/components/landing/featured-jobs';
import { TrustNotice } from '@/components/landing/trust-notice';

/** หน้าแรกเป็นชุด Tile เต็มความกว้างสลับพื้นขาว / Parchment / เข้ม (DESIGN-apple) — สีพื้นที่เปลี่ยนทำหน้าที่แบ่งส่วน */
export default function HomePage() {
  return (
    <main>
      <Hero />
      <CategorySection />
      <section aria-labelledby="jobs-title" className="bg-surface px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="jobs-title" className="text-3xl font-semibold sm:text-[40px] sm:leading-[1.1]">งานฝึกงานที่เปิดรับ</h2>
            </div>
            <Link href="/jobs" className="text-primary hover:underline">ดูทั้งหมด ›</Link>
          </div>
          <FeaturedJobs />
        </div>
      </section>
      <TrustNotice />
    </main>
  );
}
