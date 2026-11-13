import { Injectable } from '@nestjs/common';
import { AppException } from '@internpath/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Page, skipOf } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { evaluateJob } from '../screening/evaluate';
import { normalizeText } from '../screening/normalize';
import type { Evaluation } from '../screening/types';
import { CreateTermDto, RuleUpdateDto, TermQuery, UpdateRiskRulesDto, UpdateTermDto } from './dto';
import { RulesRepository } from './rules.repository';

export interface TermRow {
  id: string;
  term: string;
  severity: 'HARD' | 'SOFT';
  weight: number | null;
  category: string;
  enabled: boolean;
  created_at: Date;
}

export interface RiskRulesView {
  rules: Array<{ code: string; weight: number; params: Record<string, number>; enabled: boolean }>;
  negation_cues: Array<{ id: string; cue: string; enabled: boolean }>;
}

export interface Actor {
  sub: string;
}

const invalid = (field: string, issue: string): AppException =>
  new AppException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 400, [{ field, issue }]);

const toRow = (t: {
  id: string;
  term: string;
  severity: 'HARD' | 'SOFT';
  weight: number | null;
  category: string;
  enabled: boolean;
  createdAt: Date;
}): TermRow => ({
  id: t.id,
  term: t.term,
  severity: t.severity,
  weight: t.weight,
  category: t.category,
  enabled: t.enabled,
  created_at: t.createdAt,
});

@Injectable()
export class RulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly repo: RulesRepository,
  ) {}

  async listTerms(q: TermQuery): Promise<Page<TermRow>> {
    const where: Prisma.BlacklistTermWhereInput = {
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
      ...(q.q ? { term: { contains: q.q.toLowerCase() } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.blacklistTerm.findMany({ where, orderBy: [{ severity: 'asc' }, { term: 'asc' }], skip: skipOf(q), take: q.page_size }),
      this.prisma.blacklistTerm.count({ where }),
    ]);
    return { data: rows.map(toRow), meta: { page: q.page, page_size: q.page_size, total } };
  }

  async createTerm(dto: CreateTermDto, admin: Actor, correlationId?: string): Promise<TermRow> {
    if (dto.severity === 'HARD' && dto.weight !== undefined) throw invalid('weight', 'HARD ห้ามมี weight');
    if (dto.severity === 'SOFT' && dto.weight === undefined) throw invalid('weight', 'SOFT ต้องมี weight');
    // เก็บเป็นตัวพิมพ์เล็กและผ่าน normalizeText เพื่อให้ตรงกับการสแกน (ไม่สนตัวพิมพ์) และกันคำซ้ำ
    const term = normalizeText(dto.term).trim().toLowerCase();
    if (!term) throw invalid('term', 'ต้องไม่ว่าง');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.blacklistTerm.create({
          data: { term, severity: dto.severity, weight: dto.weight ?? null, category: dto.category ?? 'GENERAL', createdBy: admin.sub },
        });
        await this.audit.record(tx, {
          adminId: admin.sub,
          action: 'BLACKLIST_CREATE',
          targetType: 'blacklist_term',
          targetId: row.id,
          after: toRow(row),
          correlationId,
        });
        return toRow(row);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppException('TERM_EXISTS', 'มีคำนี้อยู่แล้ว', 409);
      }
      throw e;
    }
  }

  async updateTerm(id: string, dto: UpdateTermDto, admin: Actor, correlationId?: string): Promise<TermRow> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.blacklistTerm.findUnique({ where: { id } });
      if (!before) throw new AppException('NOT_FOUND', 'ไม่พบคำนี้', 404);
      if (dto.weight !== undefined && before.severity === 'HARD') throw invalid('weight', 'HARD ห้ามมี weight');
      const row = await tx.blacklistTerm.update({
        where: { id },
        data: {
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
        },
      });
      await this.audit.record(tx, {
        adminId: admin.sub,
        action: 'BLACKLIST_UPDATE',
        targetType: 'blacklist_term',
        targetId: id,
        before: toRow(before),
        after: toRow(row),
        correlationId,
      });
      return toRow(row);
    });
  }

  async removeTerm(id: string, admin: Actor, correlationId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.blacklistTerm.findUnique({ where: { id } });
      if (!before) throw new AppException('NOT_FOUND', 'ไม่พบคำนี้', 404);
      await tx.blacklistTerm.delete({ where: { id } });
      await this.audit.record(tx, {
        adminId: admin.sub,
        action: 'BLACKLIST_DELETE',
        targetType: 'blacklist_term',
        targetId: id,
        before: toRow(before),
        correlationId,
      });
    });
  }

  /** ทดสอบข้อความกับกฎปัจจุบัน — ไม่บันทึกอะไร; ปิดกฎ "รายละเอียดสั้นเกินไป" เพราะทดสอบข้อความเดี่ยวๆ */
  async testText(text: string): Promise<Pick<Evaluation, 'decision' | 'risk_level' | 'risk_score' | 'matched_keywords' | 'reasons'>> {
    const rules = await this.repo.load(this.prisma);
    const e = evaluateJob(
      {
        content: { job_title: '', description: text, responsibilities: '', qualifications: '', allowance_text: '', location: '' },
        hours_per_week: 35,
        allowance: { type: 'AMOUNT', amount_thb: 5000 },
        company_flag_under_review: false,
      },
      { ...rules, riskRules: rules.riskRules.map((r) => (r.code === 'DESCRIPTION_TOO_SHORT' ? { ...r, enabled: false } : r)) },
    );
    return { decision: e.decision, risk_level: e.risk_level, risk_score: e.risk_score, matched_keywords: e.matched_keywords, reasons: e.reasons };
  }

  async getRules(): Promise<RiskRulesView> {
    const [rules, cues] = await Promise.all([
      this.prisma.riskRule.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.negationCue.findMany({ orderBy: { cue: 'asc' } }),
    ]);
    return {
      rules: rules.map((r) => ({ code: r.code, weight: r.weight, params: (r.params ?? {}) as Record<string, number>, enabled: r.enabled })),
      negation_cues: cues.map((c) => ({ id: c.id, cue: c.cue, enabled: c.enabled })),
    };
  }

  async updateRules(dto: UpdateRiskRulesDto, admin: Actor, correlationId?: string): Promise<RiskRulesView> {
    const ruleUpdates = dto.rules ?? [];
    const cueUpdates = dto.negation_cues ?? [];
    if (ruleUpdates.length === 0 && cueUpdates.length === 0) return this.getRules();

    // ตรวจทุกรายการก่อนแก้ — ถ้ามีรายการผิดรายการเดียว ไม่เปลี่ยนอะไรเลย
    const existing = new Map((await this.prisma.riskRule.findMany()).map((r) => [r.code, r]));
    ruleUpdates.forEach((u, i) => this.validateRuleUpdate(u, i, existing.has(u.code)));

    const before = await this.getRules();
    await this.prisma.$transaction(async (tx) => {
      for (const u of ruleUpdates) {
        const cur = existing.get(u.code)!;
        await tx.riskRule.update({
          where: { code: u.code },
          data: {
            ...(u.weight !== undefined ? { weight: u.weight } : {}),
            ...(u.enabled !== undefined ? { enabled: u.enabled } : {}),
            ...(u.params ? { params: { ...((cur.params ?? {}) as Record<string, number>), ...u.params } } : {}),
            updatedBy: admin.sub,
            updatedAt: new Date(),
          },
        });
      }
      for (const c of cueUpdates) {
        const cue = normalizeText(c.cue).trim().toLowerCase();
        await tx.negationCue.upsert({ where: { cue }, create: { cue, enabled: c.enabled }, update: { enabled: c.enabled } });
      }
      const after = {
        rules: (await tx.riskRule.findMany({ orderBy: { code: 'asc' } })).map((r) => ({ code: r.code, weight: r.weight, params: r.params, enabled: r.enabled })),
        negation_cues: (await tx.negationCue.findMany({ orderBy: { cue: 'asc' } })).map((c) => ({ cue: c.cue, enabled: c.enabled })),
      };
      await this.audit.record(tx, {
        adminId: admin.sub,
        action: 'RISK_RULES_UPDATE',
        targetType: 'risk_rules',
        targetId: 'risk_rules',
        before: { rules: before.rules, negation_cues: before.negation_cues.map((c) => ({ cue: c.cue, enabled: c.enabled })) },
        after,
        correlationId,
      });
    });
    return this.getRules();
  }

  private validateRuleUpdate(u: RuleUpdateDto, index: number, exists: boolean): void {
    const f = (name: string) => `rules[${index}].${name}`;
    if (!exists) throw invalid(f('code'), `ไม่มีกฎรหัส ${u.code}`);
    if (u.params) {
      for (const [k, v] of Object.entries(u.params)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(f(`params.${k}`), 'ต้องเป็นตัวเลข');
      }
      if (u.code === 'NEGATION_WINDOW' && u.params.max_gap !== undefined && !(u.params.max_gap >= 0 && u.params.max_gap <= 100)) {
        throw invalid(f('params.max_gap'), 'ต้องอยู่ระหว่าง 0 ถึง 100');
      }
    }
  }
}
