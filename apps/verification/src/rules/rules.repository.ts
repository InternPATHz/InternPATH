import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Rules } from '../screening/types';

type Db = Pick<PrismaClient, 'blacklistTerm' | 'negationCue' | 'riskRule'>;

/** โหลดกฎคัดกรองจาก DB (เฉพาะแถวที่ enabled) — ใช้ได้ทั้งกับ PrismaService และ tx */
@Injectable()
export class RulesRepository {
  async load(db: Db): Promise<Rules> {
    const [terms, cues, rules] = await Promise.all([
      db.blacklistTerm.findMany({ where: { enabled: true } }),
      db.negationCue.findMany({ where: { enabled: true } }),
      db.riskRule.findMany({ where: { enabled: true } }),
    ]);
    return {
      blacklist: terms.map((t) => ({ term: t.term, severity: t.severity, weight: t.weight })),
      negationCues: cues.map((c) => c.cue),
      riskRules: rules.map((r) => ({
        code: r.code,
        weight: r.weight,
        params: (r.params ?? {}) as Record<string, number>,
        enabled: true,
      })),
    };
  }
}
