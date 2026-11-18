import type { Role } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Application } from '../../generated/client';
import { LifecycleConfigService } from '../config/lifecycle-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApplicationTransitionService,
  hasOtherConfirmed,
  loadDisputeContext,
  type PendingQuotaEffect,
  type TransitionCommand,
  type TransitionOutcome,
} from './application-transition.service';
import { computeAvailableActions, type AvailableActions } from './available-actions';
import { applicationNotFound, stateConflict } from './errors';
import { checkGuards, type GuardConfig } from './guards';
import { QuotaLeaseService } from './quota-lease.service';
import { QuotaService, collectQuotaEffects } from './quota.service';
import { findTransition } from './transition-table';

export interface ExecuteResult extends TransitionOutcome {
  /** confirm/release ที่เรียก Job ไม่สำเร็จหลัง commit (รอ Reconciliation) */
  quotaFailures: PendingQuotaEffect[];
}

/**
 * จุดเข้าสำหรับ endpoint (หัวข้อ 1.4–1.9): ตรวจ Guard ล่วงหน้า → reserve โควตา (ถ้ามี) →
 * เปลี่ยนสถานะใน Transaction → confirm/release โควตาหลัง commit
 * ผู้เรียกต้องตรวจความเป็นเจ้าของ (`assert*Ownership`) ก่อนเรียกเสมอ
 *
 * Consumer/Scheduler ที่ได้ `tx` มาแล้วให้เรียก `ApplicationTransitionService.apply` ตรง
 */
@Injectable()
export class ApplicationStateMachine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: ApplicationTransitionService,
    private readonly quota: QuotaService,
    private readonly config: LifecycleConfigService,
    private readonly lease: QuotaLeaseService,
  ) {}

  async loadGuardConfig(): Promise<GuardConfig> {
    const [minActualDays, disputeWindowDays, noEvaluationAfterDays] = await Promise.all([
      this.config.getNumber('CERT_MIN_ACTUAL_DAYS'),
      this.config.getNumber('DISPUTE_WINDOW_DAYS'),
      this.config.getNumber('SLA_EVALUATION_DAYS'),
    ]);
    return { minActualDays, disputeWindowDays, noEvaluationAfterDays };
  }

  async execute(applicationId: string, command: TransitionCommand, now = new Date()): Promise<ExecuteResult> {
    const before = await this.prisma.application.findUnique({ where: { id: applicationId } });
    if (!before) throw applicationNotFound();
    const rule = findTransition(before.status, command.trigger, command.actor.role, command.to);
    if (!rule) throw stateConflict();
    const config = await this.loadGuardConfig();

    // คำสั่งที่จองโควตา: ถือ lease ของใบนี้ตั้งแต่ก่อน reserve จนจบขั้น compensate/settle (QIR-01) —
    // คำสั่งอื่นที่เรียกโควตาของใบเดียวกันต้องรอ (ได้ 409) ไม่ให้ release ชดเชยที่ค้างไปชนกับการจองรอบใหม่
    let leaseToken: Date | null = null;
    try {
      // ตรวจล่วงหน้านอก Transaction เพื่อไม่จองโควตาทั้งที่ Guard ไม่ผ่าน (ตรวจซ้ำใน Transaction อีกรอบ)
      if (rule.quota === 'RESERVE') {
        const failure = checkGuards(
          rule.guards,
          {
            application: before,
            now,
            config,
            input: { ...command.input, reason: command.reason },
            studentHasOtherConfirmed: await hasOtherConfirmed(this.prisma, before),
          },
          'execute',
        );
        if (failure) throw failure;
        leaseToken = await this.lease.acquire(before.id);
        if (!leaseToken) throw stateConflict('QUOTA_OPERATION_IN_PROGRESS');
        // ผู้ถือ lease รายก่อนอาจเพิ่ง commit/ล้มไป — ยืนยันว่ายังทำรายการนี้ได้ก่อนเรียก Job
        const current = await this.prisma.application.findUnique({ where: { id: applicationId } });
        if (!current || !findTransition(current.status, command.trigger, command.actor.role, command.to)) {
          throw stateConflict();
        }
        await this.quota.reserve(before.jobId, before.id, command.correlationId);
      }

      let outcome: TransitionOutcome;
      try {
        outcome = await this.prisma.$transaction(async (tx) => {
          const fresh = await tx.application.findUnique({ where: { id: applicationId } });
          if (!fresh) throw applicationNotFound();
          return this.transitions.apply(tx, fresh, command, now, config);
        });
      } catch (error) {
        if (rule.quota === 'RESERVE' && !(await this.isQuotaHeld(applicationId))) {
          await this.quota.compensate(before.jobId, before.id, command.correlationId);
        }
        throw error;
      }

      const quotaFailures = await this.quota.settle(collectQuotaEffects(outcome), command.correlationId);
      return { ...outcome, quotaFailures };
    } finally {
      if (leaseToken) await this.lease.release(before.id, leaseToken);
    }
  }

  /**
   * ก่อน release ชดเชย: Job จองแบบ idempotent ด้วย `application_id` ⇒ ถ้าอีกคำสั่ง (เช่น HR กดตอบรับซ้ำพร้อมกัน)
   * ชนะและถือโควตาไว้แล้ว (`quota_reserved = true`) การ release จะปลดโควตาของผู้ชนะ จึงต้องข้าม (PM รีวิว PR #36)
   * ผู้แพ้ได้ `STATE_CONFLICT` หลังผู้ชนะ commit แล้วเสมอ (updateMany รอ row lock) ค่าที่อ่านจึงเป็นค่าล่าสุด
   * อ่านไม่สำเร็จ ⇒ ถือว่ามีคนถืออยู่ (ไม่ release) — จองค้างแก้ได้ด้วย Reconciliation แต่ release ผิดทำให้รับเกินโควตา
   */
  private async isQuotaHeld(applicationId: string): Promise<boolean> {
    try {
      const current = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { quotaReserved: true },
      });
      return current?.quotaReserved === true;
    } catch {
      return true;
    }
  }

  /** ปุ่มที่ role นี้กดได้สำหรับใบสมัครนี้ (ใช้ใน GET รายละเอียดของแต่ละ role) */
  async availableActions(app: Application, role: Role, now = new Date()): Promise<AvailableActions> {
    const config = await this.loadGuardConfig();
    const needsDispute = app.status === 'EVALUATED_FAIL';
    return computeAvailableActions(role, {
      application: app,
      now,
      config,
      studentHasOtherConfirmed: await hasOtherConfirmed(this.prisma, app),
      ...(needsDispute ? await loadDisputeContext(this.prisma, app.id) : {}),
      companySuspendedDecision: app.companySuspendedDecision,
      academicResult: app.academicResult,
    });
  }
}
