import Link from 'next/link';
import { CategorySection } from '@/components/landing/category-section';
import { Hero } from '@/components/landing/hero';
import { JobCard } from '@/components/landing/job-card';
import { TrustNotice } from '@/components/landing/trust-notice';
import { MOCK_JOBS } from '@/lib/mock-landing';

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
              {/* MOCK: เปลี่ยนเป็นผลจาก Job Search เมื่อเปิดให้เรียกโดยไม่ต้องล็อกอิน (ดู src/lib/mock-landing.ts) */}
              <p className="mt-2 text-ink-soft">ตัวอย่างประกาศ (ข้อมูลจำลอง)</p>
            </div>
            <Link href="/jobs" className="text-primary hover:underline">ดูทั้งหมด ›</Link>
          </div>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {MOCK_JOBS.map((item) => <JobCard key={item.job.id} item={item} />)}
          </div>
        </div>
      </section>
      <TrustNotice />
    </main>
  );
}
