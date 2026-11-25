/** ลิงก์ออกนอกเว็บที่มาจากข้อมูลผู้ใช้ — ใช้ได้เฉพาะ http(s) ไม่งั้นคืน undefined (กันลิงก์กลายเป็น path ภายในเว็บหรือสคีมอื่น) */
export function externalHref(url: string | null | undefined): string | undefined {
  const value = url?.trim();
  return value && /^https?:\/\/[^\s/]/i.test(value) ? value : undefined;
}
