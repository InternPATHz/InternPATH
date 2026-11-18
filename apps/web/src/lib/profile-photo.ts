import type { ProfilePhotoResponse } from '@internpath/contracts';

/**
 * รูปโปรไฟล์นักศึกษา (api-contract §7.1): `PUT`/`DELETE /me/profile/photo`
 * ตอนนี้ใช้ข้อมูลจำลอง (MOCK) เพราะ API ฝั่ง Lifecycle ยังไม่เปิด — ตั้ง `NEXT_PUBLIC_PROFILE_PHOTO_MOCK=false` เพื่อสลับไปเรียก API จริง
 * ข้อมูลจำลองเก็บรูปเป็น data URL ใน localStorage ของเบราว์เซอร์นี้เท่านั้น (เฉพาะตอนพัฒนา — ไม่ส่งออกจากเครื่อง)
 */
export const PROFILE_PHOTO_MOCK = process.env.NEXT_PUBLIC_PROFILE_PHOTO_MOCK !== 'false';

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = /^image\/(jpeg|png|webp)$/;

type Request = <T>(path: string, init?: { method?: 'PUT' | 'DELETE'; body?: unknown }) => Promise<T>;

/** ตรวจชนิดและขนาดฝั่งหน้าจอ (ค่าจริงตรวจ MIME จากเนื้อไฟล์ที่ Lifecycle) — คืนข้อความผิดพลาดหรือ null */
export function validatePhoto(file: File): string | null {
  if (!ALLOWED.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) return 'รูปต้องเป็นไฟล์ jpg, png หรือ webp';
  if (file.size > PHOTO_MAX_BYTES) return 'รูปต้องมีขนาดไม่เกิน 2 MB';
  return null;
}

const key = (userId: string) => `internpath.mock.profile-photo.${userId}`;

/** รูปจำลองที่เก็บไว้ (ใช้แทน `photo_url` จากเซิร์ฟเวอร์ตอนยังเป็น MOCK) */
export function mockPhotoOf(userId: string): string | undefined {
  if (!PROFILE_PHOTO_MOCK) return undefined;
  try { return localStorage.getItem(key(userId)) ?? undefined; } catch { return undefined; }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}

export async function uploadPhoto(request: Request, userId: string, file: File): Promise<string> {
  if (PROFILE_PHOTO_MOCK) {
    const url = await readAsDataUrl(file);
    try { localStorage.setItem(key(userId), url); } catch { throw new Error('เก็บรูปจำลองไม่สำเร็จ (พื้นที่เบราว์เซอร์เต็ม)'); }
    return url;
  }
  const form = new FormData();
  form.append('file', file);
  return (await request<ProfilePhotoResponse>('/me/profile/photo', { method: 'PUT', body: form })).photo_url;
}

export async function removePhoto(request: Request, userId: string): Promise<void> {
  if (PROFILE_PHOTO_MOCK) { try { localStorage.removeItem(key(userId)); } catch { /* ไม่มีอะไรต้องลบ */ } return; }
  await request<void>('/me/profile/photo', { method: 'DELETE' });
}
