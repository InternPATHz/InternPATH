export function Hero() {
  return (
    <section className="rounded-2xl bg-primary-soft p-6 sm:p-10">
      <p className="inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
        เริ่มต้นสืบค้นข้อมูลงานฝึกงาน
      </p>
      <h2 className="mt-4 text-3xl font-bold leading-thai sm:text-4xl">
        โอกาสฝึกงานที่ใช่<br />เริ่มจากข้อมูลที่ชัดเจน
      </h2>
      <p className="mt-3 max-w-2xl text-sm text-ink-soft sm:text-base">
        ค้นหางานตามสายที่สนใจ อ่านรายละเอียดบริษัท และตัดสินใจสมัครด้วยข้อมูลจากแพลตฟอร์ม
      </p>
      {/* ยังไม่มีหน้า /jobs (Job Search เป็นของ Job Management) — ฟอร์มส่งคำค้นไปที่ /jobs?q= เมื่อหน้านั้นพร้อม */}
      <form action="/jobs" method="get" role="search" className="mt-6 flex flex-col gap-3 rounded-xl bg-surface p-3 shadow-sm sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">ค้นหาตำแหน่งหรือชื่อบริษัท</span>
          <input
            name="q"
            type="search"
            placeholder="ค้นหาจากตำแหน่งหรือชื่อบริษัท เช่น Software Engineer"
            className="w-full rounded-lg px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-primary-soft"
          />
        </label>
        <button type="submit" className="rounded-lg bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover">
          ค้นหางาน
        </button>
      </form>
    </section>
  );
}
