import Link from 'next/link';
import { FOOTER_LINKS } from './site-nav';

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-ink-soft sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <p className="font-semibold text-ink">INTERNPATH</p>
          <p className="mt-1">แพลตฟอร์มตัวกลางเชื่อมนักศึกษา อาจารย์ที่ปรึกษา และบริษัทสำหรับการฝึกงาน</p>
        </div>
        <nav aria-label="ลิงก์ท้ายหน้า" className="flex flex-wrap gap-x-5 gap-y-2">
          {FOOTER_LINKS.filter((item) => item.ready).map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-primary">{item.label}</Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
