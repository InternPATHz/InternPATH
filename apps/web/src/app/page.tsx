import Link from 'next/link';

const roles = [
  'นักศึกษา',
  'ฝ่ายบุคคลบริษัท',
  'อาจารย์ที่ปรึกษา',
  'ผู้ดูแลแพลตฟอร์ม',
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold">InternPath</h1>
      <p className="mt-2 text-ink-soft">แพลตฟอร์มตัวกลางเชื่อมนักศึกษา อาจารย์ และบริษัทสำหรับการฝึกงาน</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/register" className="rounded-lg bg-primary px-5 py-3 font-semibold text-white hover:bg-primary-hover">สมัครสมาชิก</Link>
        <Link href="/login" className="rounded-lg border border-border px-5 py-3 font-semibold text-primary hover:bg-primary-soft">เข้าสู่ระบบ</Link>
        <Link href="/account" className="rounded-lg border border-border px-5 py-3 font-semibold text-ink hover:bg-surface-muted">บัญชีของฉัน</Link>
      </div>
      <ul className="mt-10 grid gap-3 sm:grid-cols-2">
        {roles.map((role) => (
          <li key={role} className="rounded-lg border border-border bg-surface-muted p-4">
            <span className="font-medium">{role}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
