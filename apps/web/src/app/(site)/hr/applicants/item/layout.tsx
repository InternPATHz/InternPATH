import type { ReactNode } from 'react';

// ชื่อแท็บของหน้านี้ — ต่อท้ายด้วย template ของ layout แม่ (" · InternPath" หรือ " · InternPath Admin")
// absolute: layout แม่ตั้ง title เป็นข้อความ ทำให้ template ไม่ต่อให้หน้าลูก จึงเขียนชื่อเต็มเอง
export const metadata = { title: { absolute: 'รายละเอียดผู้สมัคร · InternPath' } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
