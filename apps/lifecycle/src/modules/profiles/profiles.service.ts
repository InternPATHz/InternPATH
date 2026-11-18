import { Injectable, Logger } from '@nestjs/common';
import type { InternalStudentResponse, ProfilePhotoResponse, StudentProfile } from '@internpath/contracts';
import type { StudentProfile as StudentProfileRow } from '../../../generated/client';
import { S3StorageService } from '../../common/storage/s3-storage.service';
import { LifecycleConfigService } from '../../config/lifecycle-config.service';
import { IdentityInternalClient } from '../../internal/identity-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { preparePhoto, type UploadedPhotoFile } from './photo-file';
import { UpdateProfileDto } from './profiles.dto';

/** prefix ของ Object Key รูปโปรไฟล์ใน Private bucket (key สุ่ม UUID — README §5.9) */
export const PHOTO_KEY_PREFIX = 'profile-photos';

/**
 * แปลงแถว DB เป็น Response ตาม `StudentProfile` ใน @internpath/contracts (ฟิลด์ว่างไม่ส่ง)
 * `photoUrl` = Signed URL ที่ผู้เรียกออกให้หลังตรวจสิทธิ์แล้ว — **ห้ามคืน `photo_key`** (data-schema §6)
 */
export function toStudentProfile(row: StudentProfileRow, photoUrl?: string): StudentProfile {
  return {
    ...(row.headline ? { headline: row.headline } : {}),
    skills: row.skills,
    ...(row.bio ? { bio: row.bio } : {}),
    ...(row.portfolioUrl ? { portfolio_url: row.portfolioUrl } : {}),
    ...(photoUrl ? { photo_url: photoUrl } : {}),
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
    private readonly storage: S3StorageService,
    private readonly config: LifecycleConfigService,
  ) {}

  /**
   * GET /me/profile — ยังไม่มีแถว ⇒ สร้างจากข้อมูล Identity (ฟิลด์อื่นว่าง)
   * คำขอแรกพร้อมกันหลายคำขอ (React effect สองรอบ / เปิดสองแท็บ) จะชน unique `user_id` ตอนสร้าง
   * ⇒ ถือว่าอีกคำขอสร้างให้แล้ว อ่านแถวนั้นคืน (ไม่ใช่ข้อผิดพลาด)
   */
  async get(userId: string, correlationId?: string): Promise<StudentProfile> {
    const existing = await this.db.studentProfile.findUnique({ where: { userId } });
    if (existing) return this.respond(existing);

    const student = await this.identity.getStudent(userId, correlationId);
    try {
      const created = await this.db.studentProfile.upsert({
        where: { userId },
        create: { userId, major: student.major, yearLevel: student.year_level, skills: [] },
        update: {},
      });
      return this.respond(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.db.studentProfile.findUnique({ where: { userId } });
      if (!winner) throw error;
      return this.respond(winner);
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
      return this.respond(saved);
    }

    const copy = { major: student.major, yearLevel: student.year_level };
    try {
      const saved = await this.db.studentProfile.upsert({
        where: { userId },
        create: { userId, ...copy, ...editable },
        update: { ...copy, ...editable },
      });
      return this.respond(saved);
    } catch (error) {
      // อีกคำขอ (GET/PUT ครั้งแรก) สร้างแถวไปก่อนระหว่างนี้ ⇒ แถวมีแล้ว แก้ทับด้วยค่าของคำขอนี้
      if (!isUniqueViolation(error)) throw error;
      const saved = await this.db.studentProfile.update({ where: { userId }, data: { ...copy, ...editable } });
      return this.respond(saved);
    }
  }

  // ---------- รูปโปรไฟล์ (api-contract §7.1 — PM ตัดสิน 2026-11-18) ----------

  /**
   * PUT /me/profile/photo — ตรวจ MIME จริง + ล้าง metadata → Private bucket → แทนที่รูปเดิมแล้วลบไฟล์เก่า
   * ยังไม่มีโปรไฟล์ ⇒ สร้างจาก Identity ก่อน (เหมือน GET) • DB ล้ม ⇒ ลบไฟล์ใหม่ทิ้ง (ไม่ค้างใน Storage)
   */
  async uploadPhoto(userId: string, file: UploadedPhotoFile | undefined, correlationId?: string): Promise<ProfilePhotoResponse> {
    const photo = await preparePhoto(file);
    await this.get(userId, correlationId);
    const key = this.storage.generateKey(PHOTO_KEY_PREFIX, photo.extension);
    await this.storage.upload(key, photo.buffer, photo.mime);

    let previous: string | null;
    try {
      previous = await this.db.$transaction(async (tx) => {
        // ล็อกแถว — อัปโหลดพร้อมกันสองคำขอ: ผู้มาทีหลังเห็น key ของผู้มาก่อนแล้วลบทิ้ง (ไม่มีไฟล์ค้าง)
        await tx.$queryRaw`SELECT user_id FROM student_profiles WHERE user_id = ${userId}::uuid FOR UPDATE`;
        const row = await tx.studentProfile.findUniqueOrThrow({ where: { userId }, select: { photoKey: true } });
        await tx.studentProfile.update({ where: { userId }, data: { photoKey: key } });
        return row.photoKey;
      });
    } catch (error) {
      await this.storage.delete(key).catch(() => this.logger.warn(`ลบรูปที่อัปโหลดไม่สำเร็จหลัง DB ล้ม (key ค้าง)`));
      throw error;
    }
    if (previous) await this.deleteFileQuietly(previous);
    return { photo_url: await this.signed(key) };
  }

  /** DELETE /me/profile/photo — ลบไฟล์ก่อนแล้วล้าง `photo_key` (Storage ล้ม ⇒ error, ไม่มีอะไรเปลี่ยน) • ไม่มีรูป ⇒ 204 (idempotent) */
  async deletePhoto(userId: string): Promise<void> {
    const row = await this.db.studentProfile.findUnique({ where: { userId }, select: { photoKey: true } });
    if (!row?.photoKey) return;
    await this.storage.delete(row.photoKey);
    // ล้างเฉพาะถ้ายังเป็น key เดิม (อัปโหลดใหม่แทรกเข้ามา ⇒ คงรูปใหม่ไว้)
    await this.db.studentProfile.updateMany({ where: { userId, photoKey: row.photoKey }, data: { photoKey: null } });
  }

  /** Signed URL ของรูปตาม key — ใช้ร่วมกับฝั่ง HR (เฉพาะเมื่อมี Consent) */
  async signedPhotoUrl(photoKey: string | null | undefined): Promise<string | undefined> {
    return photoKey ? this.signed(photoKey) : undefined;
  }

  private async respond(row: StudentProfileRow): Promise<StudentProfile> {
    return toStudentProfile(row, await this.signedPhotoUrl(row.photoKey));
  }

  private async signed(key: string): Promise<string> {
    return this.storage.getSignedDownloadUrl(key, await this.config.getNumber('SIGNED_URL_EXPIRES_SECONDS'));
  }

  /** ไฟล์เก่าหลังแทนที่ — ลบไม่ได้ไม่ทำให้คำขอล้ม (รูปใหม่บันทึกแล้ว) แค่ log (ไม่ log key) */
  private async deleteFileQuietly(key: string): Promise<void> {
    await this.storage.delete(key).catch(() => this.logger.warn('ลบรูปโปรไฟล์เก่าไม่สำเร็จ — ไฟล์ค้างใน Storage'));
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
