const badges = [
  ['Verified by Platform', 'แพลตฟอร์มตรวจสอบเอกสารและตัวตนของบริษัทแล้ว'],
  ['University Partner', 'บริษัทมีข้อตกลงความร่วมมือกับมหาวิทยาลัย'],
  ['Featured', 'บริการจัดให้ประกาศแสดงก่อน ผู้สมัครดูความน่าเชื่อถือจากป้ายรับรองและรีวิวได้'],
];

export function TrustNotice() {
  return (
    <aside aria-labelledby="trust-title" className="bg-tile px-4 py-16 text-white sm:py-20">
      <div className="mx-auto max-w-6xl">
        <h2 id="trust-title" className="text-3xl font-semibold sm:text-[40px] sm:leading-tight">อ่านป้ายให้เข้าใจก่อนกดสมัคร</h2>
        <dl className="mt-8 grid gap-4 sm:grid-cols-3">
          {badges.map(([name, description]) => (
            <div key={name} className="rounded-xl border border-white/10 bg-white/5 p-5">
              <dt className="font-semibold">{name}</dt>
              <dd className="mt-2 text-sm text-white/75">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}
