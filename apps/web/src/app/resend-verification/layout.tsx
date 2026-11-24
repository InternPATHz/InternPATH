import type { ReactNode } from 'react';

// ชื่อแท็บของหน้านี้ — ต่อท้ายด้วย template ของ layout แม่ (" · InternPath" หรือ " · InternPath Admin")
export const metadata = { title: 'ขอลิงก์ยืนยันใหม่' };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
