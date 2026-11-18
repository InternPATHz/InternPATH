import { Injectable, Logger } from '@nestjs/common';
import type { InternalStudentResponse, StudentProfile } from '@internpath/contracts';
import type { StudentProfile as StudentProfileRow } from '../../../generated/client';
import { IdentityInternalClient } from '../../internal/identity-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateProfileDto } from './profiles.dto';

/** แปลงแถว DB เป็น Response ตาม `StudentProfile` ใน @internpath/contracts (ฟิลด์ว่างไม่ส่ง) */
export function toStudentProfile(row: StudentProfileRow): StudentProfile {
  return {
    ...(row.headline ? { headline: row.headline } : {}),
    skills: row.skills,
    ...(row.bio ? { bio: row.bio } : {}),
    ...(row.portfolioUrl ? { portfolio_url: row.portfolioUrl } : {}),
    major: row.major,
    year_level: row.yearLevel,
  };
}

const emptyToNull = (value: string | undefined): string | null => (value && value.length > 0 ? value : null);

/**
 * โปรไฟล์นักศึกษา (api-contract §7.1)
 * - `major` / `year_level` เป็นสำเนาจาก Identity (`GET /internal/v1/students/{id}`) ตอนสร้าง/บันทึก (data-schema §6)
 * - ฟิลด์อื่นนักศึกษาแก้เองผ่าน PUT
 */
@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly identity: IdentityInternalClient,
  ) {}

  /**
   * GET /me/profile — ยังไม่มีแถว ⇒ สร้างจากข้อมูล Identity (ฟิลด์อื่นว่าง)
   * คำขอแรกพร้อมกันหลายคำขอ (React effect สองรอบ / เปิดสองแท็บ) จะชน unique `user_id` ตอนสร้าง
   * ⇒ ถือว่าอีกคำขอสร้างให้แล้ว อ่านแถวนั้นคืน (ไม่ใช่ข้อผิดพลาด)
   */
  async get(userId: string, correlationId?: string): Promise<StudentProfile> {
    const existing = await this.db.studentProfile.findUnique({ where: { userId } });
    if (existing) return toStudentProfile(existing);

    const student = await this.identity.getStudent(userId, correlationId);
    try {
      const created = await this.db.studentProfile.upsert({
        where: { userId },
        create: { userId, major: student.major, yearLevel: student.year_level, skills: [] },
        update: {},
      });
      return toStudentProfile(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.db.studentProfile.findUnique({ where: { userId } });
      if (!winner) throw error;
      return toStudentProfile(winner);
    }
  }

  /** PUT /me/profile — แทนที่ฟิลด์ที่แก้ได้ และรีเฟรชสำเนา major/year_level จาก Identity */
  async update(userId: string, body: UpdateProfileDto, correlationId?: string): Promise<StudentProfile> {
    const existing = await this.db.studentProfile.findUnique({ where: { userId } });
    const student = await this.studentCopy(userId, existing !== null, correlationId);

    const editable = {
      headline: emptyToNull(body.headline),
      skills: dedupe(body.skills ?? []),
      bio: emptyToNull(body.bio),
      portfolioUrl: emptyToNull(body.portfolio_url),
    };
    if (!student) {
      // มีแถวอยู่แล้วแต่ Identity ไม่พร้อม ⇒ แก้เฉพาะฟิลด์ที่แก้ได้ คงสำเนาเดิม
      const saved = await this.db.studentProfile.update({ where: { userId }, data: editable });
      return toStudentProfile(saved);
    }

    const copy = { major: student.major, yearLevel: student.year_level };
    try {
      const saved = await this.db.studentProfile.upsert({
        where: { userId },
        create: { userId, ...copy, ...editable },
        update: { ...copy, ...editable },
      });
      return toStudentProfile(saved);
    } catch (error) {
      // อีกคำขอ (GET/PUT ครั้งแรก) สร้างแถวไปก่อนระหว่างนี้ ⇒ แถวมีแล้ว แก้ทับด้วยค่าของคำขอนี้
      if (!isUniqueViolation(error)) throw error;
      const saved = await this.db.studentProfile.update({ where: { userId }, data: { ...copy, ...editable } });
      return toStudentProfile(saved);
    }
  }

  /**
   * ดึงสำเนาจาก Identity — ถ้ามีโปรไฟล์อยู่แล้วแต่ Identity ล่ม ให้ใช้สำเนาเดิมต่อ (ไม่บล็อกการแก้โปรไฟล์)
   * ถ้ายังไม่มีโปรไฟล์ ต้องได้ข้อมูลจาก Identity เท่านั้น (โยน error ต่อ)
   */
  private async studentCopy(
    userId: string,
    hasExisting: boolean,
    correlationId?: string,
  ): Promise<InternalStudentResponse | null> {
    try {
      return await this.identity.getStudent(userId, correlationId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (hasExisting && code === 'UPSTREAM_UNAVAILABLE') {
        this.logger.warn(`ใช้สำเนา major/year_level เดิม เพราะ Identity ไม่พร้อม (correlation_id=${correlationId ?? '-'})`);
        return null;
      }
      throw error;
    }
  }
}

/** Prisma P2002 = ชน unique constraint (ที่นี่คือ PK `student_profiles.user_id`) */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
