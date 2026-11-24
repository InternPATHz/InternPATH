import Link from 'next/link';
import { CategorySection } from '@/components/landing/category-section';
import { FeaturedJobs } from '@/components/landing/featured-jobs';
import { TrustNotice } from '@/components/landing/trust-notice';

const steps = [
  ['สร้างโปรไฟล์', 'เพิ่มทักษะ ผลงาน และเรซูเม่ในบัญชีที่ได้รับเชิญจากอาจารย์'],
  ['ส่งใบสมัคร', 'เลือกประกาศ ยินยอมให้ส่งเรซูเม่ และติดตามผลจากหน้าใบสมัครของฉัน'],
  ['อาจารย์อนุมัติ', 'เมื่อคุณยืนยันข้อเสนอ อาจารย์ที่ปรึกษาจะพิจารณาการออกฝึกงานผ่านระบบ'],
];

export default function HomePage() {
  return (
    <main>
      <FeaturedJobs><CategorySection /></FeaturedJobs>
      <TrustNotice />
      <section aria-labelledby="steps-title" className="bg-surface-muted px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-6xl">
          <h2 id="steps-title" className="text-3xl font-semibold sm:text-[40px] sm:leading-tight">สมัครฝึกงานได้ในสามขั้น</h2>
          <ol className="mt-8 grid gap-4 sm:grid-cols-3">
            {steps.map(([title, body], index) => (
              <li key={title} className="rounded-xl bg-surface p-6">
                <p className="text-sm font-medium text-primary">ขั้นที่ {index + 1}</p>
                <h3 className="mt-2 text-xl font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-ink-soft">{body}</p>
              </li>
            ))}
          </ol>
          <Link href="/jobs" className="mt-6 inline-block rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover">ค้นหางานฝึกงาน</Link>
        </div>
      </section>
    </main>
  );
}
