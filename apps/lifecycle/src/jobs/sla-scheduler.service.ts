import { randomUUID } from 'node:crypto';
import { OutboxWriter } from '@internpath/common';
import type { ReminderDuePayload } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Application } from '../../generated/client';
import { LifecycleConfigService } from '../config/lifecycle-config.service';
import { REMINDER_DUE, buildReminderDue } from '../events/producers/reminder-due';
import { IdentityInternalClient } from '../internal/identity-client.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/types';
import { ApplicationStateMachine } from '../state-machine/application-state-machine.service';
import { ApplicationTransitionService, type TransitionOutcome } from '../state-machine/application-transition.service';
import type { GuardConfig } from '../state-machine/guards';
import { QuotaService, collectQuotaEffects } from '../state-machine/quota.service';
import { SYSTEM_ACTOR } from '../state-machine/status-history.writer';
import {
  EXPIRE_LOG_TYPE,
  SLA_CONFIG_KEYS,
  SLA_STATUSES,
  bangkokStartOfDay,
  decideSla,
  type SlaAudience,
  type SlaConfig,
  type SlaDecision,
  type SlaFacts,
} from './sla-rules';

/** ผลของการรัน 1 รอบ (ใช้ log และเทสต์) */
export interface SlaRunResult {
  scanned: number;
  reminded: number;
  expired: number;
  /** ส่ง/หมดอายุไปแล้ว (reminder_log ซ้ำ) หรือสถานะเปลี่ยนระหว่างรอบ */
  skipped: number;
  /** ล้มเหลวรายใบ (เช่น Identity ล่มตอนหารายชื่อ HR) — ไม่เขียน reminder_log ⇒ ลองใหม่รอบถัดไป */
  failed: number;
}

const BATCH_SIZE = 500;

/** โยนเพื่อ rollback แถว reminder_log เมื่อตรวจซ้ำใน Transaction แล้วไม่ต้องทำ */
class SkipDecision extends Error {}

/**
 * SLA Scheduler (README §5.3, data-schema §6 `reminder_log`, event-contract E14)
 * - **Idempotent:** เขียน `reminder_log` (UNIQUE `entity_id`+`type`+`due_date`) ก่อน แล้วเขียน Outbox E14 ใน Transaction เดียว —
 *   รันซ้อน/รีสตาร์ตก็เตือนครั้งเดียว (UAT-45); การหมดอายุเขียน log ชนิด `EXPIRED` แบบเดียวกัน
 * - ตรวจซ้ำในTransaction หลังล็อกแถวใบสมัคร (HR/นักศึกษากดพร้อมกันกับรอบนี้ ⇒ ไม่หมดอายุ/ไม่เตือนผิดสถานะ)
 * - `EXPIRED` ผ่าน State Machine (SYSTEM) ⇒ status_history + E08; คืนโควตาหลัง commit (`QuotaService.settle`)
 * - ค่า SLA อ่านจาก config กลางทุกรอบ (`config_overrides` เร่งเวลาทดสอบ UAT-18/34/47 ได้โดยไม่ต้อง Deploy)
 */
@Injectable()
export class SlaSchedulerService {
  private readonly logger = new Logger(SlaSchedulerService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly config: LifecycleConfigService,
    private readonly identity: IdentityInternalClient,
    private readonly outbox: OutboxWriter,
    private readonly transitions: ApplicationTransitionService,
    private readonly quota: QuotaService,
    private readonly stateMachine: ApplicationStateMachine,
  ) {}

  async loadConfig(): Promise<SlaConfig> {
    const values = await Promise.all(SLA_CONFIG_KEYS.map((key) => this.config.getNumber(key)));
    return Object.fromEntries(SLA_CONFIG_KEYS.map((key, i) => [key, values[i]])) as SlaConfig;
  }

  /** รัน 1 รอบ — ใบที่ล้มไม่หยุดใบอื่น */
  async runOnce(now = new Date()): Promise<SlaRunResult> {
    const [config, guardConfig] = await Promise.all([this.loadConfig(), this.stateMachine.loadGuardConfig()]);
    const correlationId = randomUUID();
    const hrCache = new Map<string, Promise<ReminderDuePayload['audience']>>();
    const result: SlaRunResult = { scanned: 0, reminded: 0, expired: 0, skipped: 0, failed: 0 };

    let cursor: string | undefined;
    for (;;) {
      const batch = await this.db.application.findMany({
        where: { status: { in: [...SLA_STATUSES] }, frozen: false },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      const withCertificate = await this.applicationsWithCertificate(batch);

      for (const app of batch) {
        result.scanned += 1;
        const facts: SlaFacts = { hasCertificate: withCertificate.has(app.id) };
        const decision = decideSla(app, config, now, facts);
        if (decision.kind === 'NONE') continue;
        try {
          const done =
            decision.kind === 'EXPIRE'
              ? await this.expire(app, decision, config, guardConfig, now, correlationId)
              : await this.remind(app, decision, config, now, correlationId, hrCache);
          if (!done) result.skipped += 1;
          else if (decision.kind === 'EXPIRE') result.expired += 1;
          else result.reminded += 1;
        } catch (error) {
          result.failed += 1;
          // ไม่ log ข้อความ error เต็ม (อาจมีข้อมูลจาก upstream) — แค่ชนิดและ id
          this.logger.warn(`SLA ${decision.kind} failed application=${app.id} error=${(error as Error).name}`);
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }

    if (result.reminded || result.expired || result.failed) {
      this.logger.log(
        `SLA run scanned=${result.scanned} reminded=${result.reminded} expired=${result.expired} skipped=${result.skipped} failed=${result.failed}`,
      );
    }
    return result;
  }

  // ---------- หมดอายุ ----------

  private async expire(
    app: Application,
    decision: Extract<SlaDecision, { kind: 'EXPIRE' }>,
    config: SlaConfig,
    guardConfig: GuardConfig,
    now: Date,
    correlationId: string,
  ): Promise<boolean> {
    let outcome: TransitionOutcome | null;
    try {
      outcome = await this.db.$transaction(async (tx) => {
        if (!(await this.claim(tx, app.id, EXPIRE_LOG_TYPE, decision.dueDate))) return null;
        const fresh = await this.lockAndRecheck(tx, app, config, now, 'EXPIRE');
        return this.transitions.apply(tx, fresh, { trigger: 'expire', actor: SYSTEM_ACTOR, correlationId }, now, guardConfig);
      });
    } catch (error) {
      if (error instanceof SkipDecision) return false;
      throw error;
    }
    if (!outcome) return false;
    // คืนโควตาหลัง commit (HR_ACCEPTED / ADVISOR_APPROVED) — Job ล่ม ⇒ รอ Reconciliation ไม่ rollback สถานะ
    await this.quota.settle(collectQuotaEffects(outcome), correlationId);
    return true;
  }

  // ---------- เตือน ----------

  private async remind(
    app: Application,
    decision: Extract<SlaDecision, { kind: 'REMIND' }>,
    config: SlaConfig,
    now: Date,
    correlationId: string,
    hrCache: Map<string, Promise<ReminderDuePayload['audience']>>,
  ): Promise<boolean> {
    const { milestone } = decision;
    // ข้ามก่อนเรียก Identity ถ้าส่งไปแล้ว (รอบปกติส่วนใหญ่เข้ากรณีนี้)
    const already = await this.db.reminderLog.findUnique({
      where: { entityId_type_dueDate: { entityId: app.id, type: milestone.type, dueDate: decision.dueDate } },
      select: { id: true },
    });
    if (already) return false;

    // หารายชื่อนอก Transaction — Identity ล่ม ⇒ throw (ไม่เขียน log ⇒ รอบหน้าลองใหม่)
    const audience = await this.audience(app, milestone.audience, hrCache);
    const payload = buildReminderDue({
      reminderType: milestone.type,
      applicationId: app.id,
      dueDate: decision.dueDate,
      audience,
      daysOverdue: decision.elapsedDays - milestone.day,
      ...(decision.deadline ? { deadlineAt: bangkokStartOfDay(decision.deadline) } : {}),
    });

    try {
      return await this.db.$transaction(async (tx) => {
        if (!(await this.claim(tx, app.id, milestone.type, decision.dueDate))) return false;
        await this.lockAndRecheck(tx, app, config, now, 'REMIND', milestone.type);
        await this.outbox.add(tx, { type: REMINDER_DUE, aggregateId: app.id, correlationId, payload });
        return true;
      });
    } catch (error) {
      if (error instanceof SkipDecision) return false;
      throw error;
    }
  }

  // ---------- helper ----------

  /** เขียน reminder_log ก่อน — ชนกับรอบที่ซ้อนกัน ⇒ ได้ 0 แถว (ไม่ error ไม่ทำให้ Transaction ล้ม) */
  private async claim(tx: Tx, entityId: string, type: string, dueDate: Date): Promise<boolean> {
    const { count } = await tx.reminderLog.createMany({
      data: [{ entityId, type, dueDate }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  /** ล็อกแถวแล้วตัดสินซ้ำด้วยข้อมูลล่าสุด — สถานะ/การตัดสินเปลี่ยน ⇒ `SkipDecision` (rollback log) */
  private async lockAndRecheck(
    tx: Tx,
    app: Application,
    config: SlaConfig,
    now: Date,
    kind: 'EXPIRE' | 'REMIND',
    type?: string,
  ): Promise<Application> {
    await tx.$queryRaw`SELECT id FROM applications WHERE id = ${app.id}::uuid FOR UPDATE`;
    const fresh = await tx.application.findUnique({ where: { id: app.id } });
    if (!fresh || fresh.status !== app.status) throw new SkipDecision();
    const hasCertificate = (await tx.certificate.count({ where: { applicationId: app.id } })) > 0;
    const again = decideSla(fresh, config, now, { hasCertificate });
    if (again.kind !== kind) throw new SkipDecision();
    if (again.kind === 'REMIND' && again.milestone.type !== type) throw new SkipDecision();
    return fresh;
  }

  private async audience(
    app: Application,
    kinds: readonly SlaAudience[],
    hrCache: Map<string, Promise<ReminderDuePayload['audience']>>,
  ): Promise<ReminderDuePayload['audience']> {
    const out: ReminderDuePayload['audience'] = [];
    for (const kind of kinds) {
      if (kind === 'STUDENT') out.push({ user_id: app.studentUserId, role: 'STUDENT' });
      if (kind === 'ADVISOR' && app.advisorUserId) out.push({ user_id: app.advisorUserId, role: 'ADVISOR' });
      if (kind === 'COMPANY_HR') {
        let members = hrCache.get(app.companyId);
        if (!members) {
          members = this.identity
            .getCompanyMembers(app.companyId)
            .then((rows) => rows.map((m) => ({ user_id: m.user_id, role: 'COMPANY_HR' })));
          // ล้มแล้วไม่ cache ไว้ทั้งรอบ — ใบถัดไปของบริษัทเดียวกันลองใหม่
          members.catch(() => hrCache.delete(app.companyId));
          hrCache.set(app.companyId, members);
        }
        out.push(...(await members));
      }
    }
    return out;
  }

  private async applicationsWithCertificate(batch: readonly Application[]): Promise<Set<string>> {
    const ids = batch.filter((a) => a.status === 'EVALUATED_PASS').map((a) => a.id);
    if (!ids.length) return new Set();
    const rows = await this.db.certificate.findMany({ where: { applicationId: { in: ids } }, select: { applicationId: true } });
    return new Set(rows.map((r) => r.applicationId));
  }
}
