'use client';

import { useEffect, useState } from 'react';
import type { AdminUniversityItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';

/** ตัวเลือกตัวกรองมหาวิทยาลัย (GET /admin/universities) — ค่าแรกคือ "ทุกมหาวิทยาลัย" */
export function useUniversityOptions(): Array<[string, string]> {
  const { request } = useAuth();
  const [items, setItems] = useState<AdminUniversityItem[]>([]);

  useEffect(() => {
    let active = true;
    request<{ data: AdminUniversityItem[] }>('/admin/universities')
      .then((result) => { if (active) setItems(result.data); })
      // ตัวกรองเป็นส่วนเสริม — โหลดไม่ได้ก็ยังใช้หน้าได้ เหลือแค่ "ทุกมหาวิทยาลัย"
      .catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [request]);

  return [['', 'ทุกมหาวิทยาลัย'],
    // มหาวิทยาลัยที่ระบบสร้างจากโดเมนอีเมลมีชื่อเท่ากับโดเมน — ไม่ต้องแสดงซ้ำ
    ...items.map((item): [string, string] => [item.id,
      `${item.name}${item.name === item.email_domain ? '' : ` (${item.email_domain})`}${item.active ? '' : ' · ปิดใช้งาน'}`])];
}
