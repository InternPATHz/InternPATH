'use client';

import { useEffect, useState } from 'react';

// รูปโปรไฟล์กลางของ UI Kit: มีรูปใช้รูป ไม่มี (หรือโหลดไม่สำเร็จ) ใช้วงกลมตัวอักษรย่อ — สีมาจาก token เท่านั้น
// รูปมาจาก Signed URL ของ Private bucket (อายุ ~10 นาที) จึงต้องรับมือกรณีลิงก์หมดอายุ (onError → ตัวอักษรย่อ)

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-8 w-8 text-sm',
  md: 'h-12 w-12 text-lg',
  lg: 'h-24 w-24 text-4xl',
};

// สระหน้าไม่ใช่ตัวอักษรตัวแรกของชื่อ (เช่น "เอก" ย่อเป็น "อ")
const LEADING_VOWELS = 'เแโใไ';

/**
 * ตัวอักษรย่อ: ชื่อไทย ⇒ พยัญชนะตัวแรก; ชื่อละติน ⇒ อักษรแรกของคำที่ 1 และ 2 (ตัวพิมพ์ใหญ่) — ไม่มีชื่อ ⇒ '?'
 * ใช้ `Array.from` เพื่อไม่ตัดกลางอักขระประกอบ
 */
export function initialsOf(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0].replace(new RegExp(`^[${LEADING_VOWELS}]+`), '') || words[0]);
  if (/[฀-๿]/.test(first[0] ?? '')) return first[0];
  const second = words[1] ? Array.from(words[1])[0] : '';
  return `${first[0] ?? ''}${second}`.toUpperCase() || '?';
}

export function Avatar({ name, src, size = 'md', className = '' }: {
  name?: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // URL ใหม่ (เช่น ได้ Signed URL ใหม่หลังหมดอายุ) ให้ลองโหลดอีกครั้ง
  useEffect(() => setFailed(false), [src]);

  const base = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${SIZE[size]} ${className}`;
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Signed URL ภายนอก ไม่ผ่าน next/image
      <img src={src} alt={name ? `รูปโปรไฟล์ของ ${name}` : 'รูปโปรไฟล์'} onError={() => setFailed(true)} className={`${base} object-cover`} />
    );
  }
  return (
    <span role="img" aria-label={name ? `ตัวอักษรย่อของ ${name}` : 'ยังไม่มีรูปโปรไฟล์'} className={`${base} bg-primary-soft font-semibold text-primary`}>
      <span aria-hidden="true">{initialsOf(name)}</span>
    </span>
  );
}
