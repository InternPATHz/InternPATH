import { Matches } from 'class-validator';

// ตั้งใจให้ regex นี้อ้างอักขระควบคุม NUL โดยตรง
// eslint-disable-next-line no-control-regex
const NO_NUL = /^[^\u0000]*$/u;

/**
 * ปฏิเสธสตริงที่มี NUL (\u0000) — Postgres เก็บใน text ไม่ได้ ถ้าปล่อยผ่านจะเป็น 500 และข้อความ error อาจฝังค่าที่ผู้ใช้กรอก (Minor #10)
 * ใช้คู่กับ `@IsString()` กับทุกฟิลด์ข้อความจากผู้ใช้ — ผิด ⇒ 400 VALIDATION_FAILED
 */
export const NoNul = (): PropertyDecorator => Matches(NO_NUL, { message: 'ห้ามมีอักขระ NUL' });
