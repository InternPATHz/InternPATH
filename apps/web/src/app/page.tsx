const roles = [
  { name: 'นักศึกษา', href: '/student' },
  { name: 'ฝ่ายบุคคลบริษัท', href: '/hr' },
  { name: 'อาจารย์ที่ปรึกษา', href: '/advisor' },
  { name: 'ผู้ดูแลแพลตฟอร์ม', href: '/admin' },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold">InternPath</h1>
      <p className="mt-2 text-ink-soft">แพลตฟอร์มตัวกลางเชื่อมนักศึกษา อาจารย์ และบริษัทสำหรับการฝึกงาน</p>
      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {roles.map((r) => (
          <li key={r.href} className="rounded-lg border border-border bg-surface-muted p-4">
            <span className="font-medium">{r.name}</span>
            <span className="ml-2 text-sm text-neutral">{r.href}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
