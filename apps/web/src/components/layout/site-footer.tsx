import Link from 'next/link';
import { FOOTER_LINKS, PUBLIC_NAV } from './site-nav';

/** ท้ายหน้าพื้น Parchment ตัวอักษรเล็กแบบ fine-print (DESIGN-apple: footer) */
export function SiteFooter() {
  const links = [...PUBLIC_NAV, ...FOOTER_LINKS].filter((item) => item.ready);
  return (
    <footer className="bg-surface-muted">
      <div className="mx-auto max-w-6xl px-4 py-10 text-xs text-ink-soft sm:px-6">
        <p className="max-w-2xl leading-relaxed">
          InternPath แพลตฟอร์มตัวกลางเชื่อมนักศึกษา อาจารย์ที่ปรึกษา และบริษัทสำหรับการฝึกงาน
          ป้าย Featured คือบริการดันประกาศ ไม่ได้รับรองความน่าเชื่อถือของบริษัท
        </p>
        <div className="mt-6 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p>สงวนลิขสิทธิ์ InternPath</p>
          <nav aria-label="ลิงก์ท้ายหน้า" className="flex flex-wrap gap-x-5 gap-y-2">
            {links.map((item) => (
              <Link key={item.href} href={item.href} className="text-ink/80 hover:text-ink hover:underline">{item.label}</Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
