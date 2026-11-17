import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';

/** เปลือกของหน้าฝั่งผู้ใช้ทั่วไป (หน้าแรก, นโยบาย ฯลฯ) — หน้า Auth ใช้ AuthShell และหน้า Admin ใช้ AdminShell ของตัวเอง */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
