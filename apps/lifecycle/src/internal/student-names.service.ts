import { Injectable, Logger } from '@nestjs/common';
import { IdentityInternalClient } from './identity-client.service';

/** เพดานของ `GET /internal/v1/students/names?ids=` (api-contract §9) */
export const STUDENT_NAMES_BATCH_MAX = 100;

/**
 * ชื่อนักศึกษาสำหรับแสดงผล (`student_name` / `full_name` ใน api-contract §7.4) จาก Identity
 * `GET /internal/v1/students/names?ids=` (แบ่งครั้งละ ≤ 100)
 *
 * - ดึงสดทุกครั้ง **ห้ามเก็บลง DB / cache / ใส่ใน Event / log** (api-contract §9)
 * - ผู้เรียกต้องตรวจสิทธิ์ (ความดูแลของอาจารย์ ฯลฯ) ก่อนเรียก
 * - Identity ล่ม / ไม่พบนักศึกษา (บัญชีถูกลบ) ⇒ ชื่อว่าง ไม่ทำให้ทั้งหน้าล้ม
 */
@Injectable()
export class StudentNamesService {
  private readonly logger = new Logger(StudentNamesService.name);

  constructor(private readonly identity: IdentityInternalClient) {}

  async names(studentUserIds: readonly string[], correlationId?: string): Promise<Map<string, string>> {
    const unique = [...new Set(studentUserIds)];
    const names = new Map<string, string>(unique.map((id) => [id, '']));
    for (let i = 0; i < unique.length; i += STUDENT_NAMES_BATCH_MAX) {
      try {
        const rows = await this.identity.getStudentNames(unique.slice(i, i + STUDENT_NAMES_BATCH_MAX), correlationId);
        for (const row of rows) if (names.has(row.user_id)) names.set(row.user_id, row.full_name);
      } catch {
        this.logger.warn('อ่านชื่อนักศึกษาจาก Identity ไม่สำเร็จ — แสดงชื่อว่าง');
      }
    }
    return names;
  }

  async name(studentUserId: string, correlationId?: string): Promise<string> {
    return (await this.names([studentUserId], correlationId)).get(studentUserId) ?? '';
  }
}
