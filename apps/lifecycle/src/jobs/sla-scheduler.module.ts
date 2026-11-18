import { Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { LifecycleConfigService } from '../config/lifecycle-config.service';
import { StateMachineModule } from '../state-machine/state-machine.module';
import { SlaSchedulerService } from './sla-scheduler.service';

export const SLA_INTERVAL_NAME = 'lifecycle-sla-scheduler';

/**
 * ตั้งรอบ Scheduler ตอนบูต — ทุก `SCHEDULER_INTERVAL_MINUTES` (ค่าเริ่มต้น 15 นาที, README §5.3)
 * กันรันซ้อนในโปรเซสเดียวด้วยธง `running`; ข้ามโปรเซส/รีสตาร์ตกันด้วย `reminder_log` (idempotent)
 * โหลดเฉพาะใน `LifecycleModule` (ไม่โหลดเมื่อ `DISABLE_INFRA=true`) — เทสต์เรียก `SlaSchedulerService.runOnce` ตรง
 */
@Injectable()
export class SlaSchedulerRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(SlaSchedulerRunner.name);
  private running = false;

  constructor(
    private readonly scheduler: SlaSchedulerService,
    private readonly config: LifecycleConfigService,
    private readonly registry: SchedulerRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const minutes = Math.max(1, await this.config.getNumber('SCHEDULER_INTERVAL_MINUTES'));
    const handle = setInterval(() => void this.tick(), minutes * 60_000);
    this.registry.addInterval(SLA_INTERVAL_NAME, handle);
    this.logger.log(`SLA scheduler every ${minutes} min (Asia/Bangkok calendar days)`);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.scheduler.runOnce();
    } catch (error) {
      this.logger.error(`SLA run failed: ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [ScheduleModule.forRoot(), StateMachineModule],
  providers: [SlaSchedulerService, SlaSchedulerRunner],
  exports: [SlaSchedulerService],
})
export class SlaSchedulerModule {}
