import Link from 'next/link';

/** Tile แรกของหน้าแรก (DESIGN-apple: product-tile-light) — หัวข้อใหญ่ชิด, บรรทัดรอง, ช่องค้นหาแคปซูล, ปุ่มแคปซูลสีน้ำเงิน */
export function Hero() {
  return (
    <section className="bg-surface px-4 pb-16 pt-14 text-center sm:pb-20 sm:pt-20">
      <p className="text-sm font-semibold text-primary">InternPath</p>
      <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold leading-[1.2] sm:text-[56px] sm:leading-[1.12]">
        ที่ฝึกงานที่ใช่<br />เริ่มจากข้อมูลที่ชัดเจน
      </h1>
      <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-soft sm:text-[21px] sm:leading-[1.45]">
        ประกาศที่ตรวจสอบแล้ว ข้อมูลบริษัท และรีวิวจากผู้ฝึกจริง ในที่เดียว
      </p>
      <form action="/jobs" method="get" role="search" className="mx-auto mt-8 flex max-w-xl flex-col gap-3 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">ค้นหาตำแหน่งหรือชื่อบริษัท</span>
          <input
            name="q"
            type="search"
            placeholder="ตำแหน่งหรือชื่อบริษัท เช่น Software Engineer"
            className="h-11 w-full rounded-full border border-black/10 bg-surface px-5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
        </label>
        <button type="submit" className="h-11 rounded-full bg-primary px-6 font-medium text-white hover:bg-primary-hover">
          ค้นหางาน
        </button>
      </form>
      <p className="mt-5 text-sm">
        <Link href="/companies" className="text-primary hover:underline">ดูบริษัทและรีวิว ›</Link>
      </p>
    </section>
  );
}
