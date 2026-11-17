import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/types';
import { reapplyBlocked } from './errors';

export interface ReapplyEligibility {
  blocked: boolean;
  /** สิทธิ์ปลดล็อกที่จะถูกใช้เมื่อสมัคร (มีเมื่อเคย `ACADEMIC_PASS` แต่ Admin ปลดล็อกแล้ว) */
  unlockId?: string;
}

/**
 * ห้ามสมัครซ้ำหลังได้ `ACADEMIC_PASS` (README 5.2) — ปลดล็อกได้โดย Admin เท่านั้น (`reapply_unlocks`)
 * สิทธิ์ปลดล็อก 1 แถว = สมัครได้ 1 ครั้ง และต้องสร้างหลังผล `ACADEMIC_PASS` ล่าสุด
 */
@Injectable()
export class ReapplyPolicy {
  async check(db: Pick<Tx, 'application' | 'reapplyUnlock'>, studentUserId: string): Promise<ReapplyEligibility> {
    const lastPass = await db.application.findFirst({
      where: { studentUserId, academicResult: 'ACADEMIC_PASS' },
      orderBy: { academicRecordedAt: 'desc' },
      select: { academicRecordedAt: true },
    });
    if (!lastPass) return { blocked: false };

    const unlock = await db.reapplyUnlock.findFirst({
      where: {
        studentUserId,
        usedAt: null,
        ...(lastPass.academicRecordedAt ? { createdAt: { gte: lastPass.academicRecordedAt } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return unlock ? { blocked: false, unlockId: unlock.id } : { blocked: true };
  }

  /**
   * ตรวจและ "ใช้สิทธิ์" ใน Transaction เดียวกับการสร้างใบสมัคร (หัวข้อ 1.4) — ตั้ง `used_at`
   * `updateMany where used_at IS NULL` กันสมัครพร้อมกันสองใบด้วยสิทธิ์เดียว
   */
  async assertAndConsume(tx: Tx, studentUserId: string, now: Date): Promise<ReapplyEligibility> {
    const eligibility = await this.check(tx, studentUserId);
    if (eligibility.blocked) throw reapplyBlocked();
    if (eligibility.unlockId) {
      const { count } = await tx.reapplyUnlock.updateMany({
        where: { id: eligibility.unlockId, usedAt: null },
        data: { usedAt: now },
      });
      if (count === 0) throw reapplyBlocked();
    }
    return eligibility;
  }
}
