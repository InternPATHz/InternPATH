import { CategorySection } from '@/components/landing/category-section';
import { Hero } from '@/components/landing/hero';
import { JobCard } from '@/components/landing/job-card';
import { SiteHeader } from '@/components/landing/site-header';
import { TrustNotice } from '@/components/landing/trust-notice';
import { MOCK_JOBS } from '@/lib/mock-landing';

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-bold">ค้นหาที่ฝึกงานอย่างมั่นใจ</h1>
        <p className="mt-2 mb-6 text-sm text-ink-soft">สำรวจงานที่ผ่านการตรวจสอบแล้ว พร้อมข้อมูลบริษัท เงื่อนไข และรีวิวจากผู้ฝึกจริง</p>
        <Hero />
        <CategorySection />
        <section aria-labelledby="jobs-title" className="mt-12">
          <h2 id="jobs-title" className="text-xl font-bold">งานฝึกงานที่เปิดรับ</h2>
          {/* MOCK: เปลี่ยนเป็นผลจาก Job Search เมื่อเปิดให้เรียกโดยไม่ต้องล็อกอิน (ดู src/lib/mock-landing.ts) */}
          <p className="mt-1 text-sm text-ink-soft">ตัวอย่างประกาศ (ข้อมูลจำลอง)</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {MOCK_JOBS.map((item) => <JobCard key={item.job.id} item={item} />)}
          </div>
        </section>
        <TrustNotice />
      </main>
    </>
  );
}
