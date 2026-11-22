// โลโก้ของ InternPath: ไอคอนสี่เหลี่ยมมุมโค้ง (public/logo.png) + ชื่อ — ใช้ร่วมทุกที่ที่แสดงแบรนด์
// ไอคอนเป็นของตกแต่ง (alt ว่าง) เพราะมีชื่อแบรนด์เป็นข้อความอยู่ข้างกันแล้ว
const SIZE = { sm: 'h-6 w-6', md: 'h-8 w-8', lg: 'h-10 w-10' } as const;

export function BrandLogo({ label = 'INTERNPATH', size = 'md', className = '' }: { label?: string; size?: keyof typeof SIZE; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {/* ใช้ <img> ตรง ๆ (ไม่ใช้ next/image) เพราะเป็นไฟล์ static ในโฟลเดอร์ public และเว็บส่งออกแบบ static */}
      <img src="/logo.png" alt="" width={128} height={128} className={`${SIZE[size]} shrink-0`} />
      <span>{label}</span>
    </span>
  );
}
