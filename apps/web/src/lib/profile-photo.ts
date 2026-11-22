import type { ProfilePhotoResponse } from '@internpath/contracts';

/** รูปโปรไฟล์นักศึกษา (api-contract §7.1): `PUT`/`DELETE /me/profile/photo` ของ Lifecycle — เก็บใน Private bucket คืนเป็น Signed URL */

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = /^image\/(jpeg|png|webp)$/;

type Request = <T>(path: string, init?: { method?: 'PUT' | 'DELETE'; body?: unknown }) => Promise<T>;

/** ตรวจชนิดและขนาดฝั่งหน้าจอ (ค่าจริงตรวจ MIME จากเนื้อไฟล์ที่ Lifecycle) — คืนข้อความผิดพลาดหรือ null */
export function validatePhoto(file: File): string | null {
  if (!ALLOWED.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) return 'รูปต้องเป็นไฟล์ jpg, png หรือ webp';
  if (file.size > PHOTO_MAX_BYTES) return 'รูปต้องมีขนาดไม่เกิน 2 MB';
  return null;
}

/** อัปโหลดรูปใหม่แทนรูปเดิม — คืน `photo_url` (Signed URL อายุสั้น) */
export async function uploadPhoto(request: Request, file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  return (await request<ProfilePhotoResponse>('/me/profile/photo', { method: 'PUT', body: form })).photo_url;
}

export async function removePhoto(request: Request): Promise<void> {
  await request<void>('/me/profile/photo', { method: 'DELETE' });
}
