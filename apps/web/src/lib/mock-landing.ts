/**
 * ชั่วคราว: ไฟล์ฝั่ง HR (`components/hr/**`) ยัง import `CATEGORIES` จากที่นี่ — คงไว้เพื่อไม่ให้ชนกับงาน HR Jobs ของ JR
 * เมื่องานนั้น merge แล้วให้เปลี่ยน import เป็น `@/lib/categories` แล้วลบไฟล์นี้
 */
export { CATEGORIES } from '@/lib/categories';
