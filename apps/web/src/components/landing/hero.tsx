import Link from 'next/link';
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';

const shortcuts = [
  ['Frontend', 'q=Frontend'], ['Data Analyst', 'q=Data+Analyst'], ['Digital Marketing', 'q=Digital+Marketing'],
  ['มีค่าตอบแทน', 'allowance=true'], ['Remote', 'work_mode=REMOTE'],
] as const;

/** Tile แรกของหน้าแรก (DESIGN-apple: product-tile-light) — หัวข้อใหญ่ชิด, บรรทัดรอง, ช่องค้นหาแคปซูล, ปุ่มแคปซูลสีน้ำเงิน */
export function Hero({ children }: { children?: ReactNode }) {
  return (
    <section className="bg-surface px-4 pb-16 pt-14 text-center sm:pb-20 sm:pt-20">
      <p className="text-lg font-semibold">InternPath</p>
      <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold leading-[1.2] sm:text-[56px] sm:leading-[1.12]">
        โอกาสฝึกงานที่ใช่<br />เริ่มจากข้อมูลที่ชัดเจน
      </h1>
      <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-soft sm:text-[21px] sm:leading-[1.45]">
        ดูประกาศที่ผ่านการตรวจสอบ ข้อมูลบริษัท เงื่อนไขงาน และรีวิวจากผู้ฝึกงานจริงก่อนตัดสินใจสมัคร
      </p>
      <form action="/jobs" method="get" role="search" className="mx-auto mt-8 flex max-w-2xl flex-col gap-3 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">ค้นหาตำแหน่งหรือชื่อบริษัท</span>
          <Search aria-hidden="true" size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-soft" />
          <input
            name="q"
            type="search"
            placeholder="ตำแหน่งหรือชื่อบริษัท เช่น Software Engineer"
            className="h-11 w-full rounded-full border border-black/10 bg-surface pl-11 pr-5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
        </label>
        <button type="submit" className="h-11 rounded-full bg-primary px-6 font-medium text-white hover:bg-primary-hover">
          ค้นหางาน
        </button>
      </form>
      <ul className="mx-auto mt-4 flex max-w-2xl flex-wrap justify-center gap-2" aria-label="ค้นหายอดนิยม">
        {shortcuts.map(([label, query]) => (
          <li key={label}><Link href={`/jobs?${query}`} className="inline-block rounded-full border border-border px-4 py-2 text-sm hover:border-primary hover:text-primary">{label}</Link></li>
        ))}
      </ul>
      {children}
    </section>
  );
}
