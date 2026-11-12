import { Controller, DynamicModule, Get, Inject, Module, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Client } from 'pg';
import * as amqp from 'amqplib';

export const HEALTH_OPTIONS = 'HEALTH_OPTIONS';

export interface HealthOptions {
  service: string;
  /** ชื่อตัวแปร env ที่เก็บ connection string ของ DB (ถ้า Service มี DB) */
  databaseUrlEnv?: string;
  /** ตรวจการเชื่อมต่อ RabbitMQ (RABBITMQ_URL) */
  requireBroker?: boolean;
}

type CheckResult = { ok: boolean; error?: string };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDatabase(url: string | undefined): Promise<CheckResult> {
  if (!url) return { ok: false, error: 'database url not configured' };
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  // กัน unhandled 'error' event ถ้า connection หลุดหลังจากเช็ก
  client.on('error', () => undefined);
  try {
    await withTimeout(client.connect(), 2500);
    await withTimeout(client.query('SELECT 1'), 2500);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    client.end().catch(() => undefined);
  }
}

async function checkBroker(url: string | undefined): Promise<CheckResult> {
  if (!url) return { ok: false, error: 'RABBITMQ_URL not configured' };
  try {
    const conn = await withTimeout(amqp.connect(url), 2500);
    await conn.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** GET /health = liveness, GET /ready = ตรวจ DB + Broker (docs/architecture.md §6) */
@Controller()
export class HealthController {
  constructor(
    @Inject(HEALTH_OPTIONS) private readonly options: HealthOptions,
    private readonly config: ConfigService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: this.options.service };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, CheckResult> = {};
    if (this.options.databaseUrlEnv) {
      checks.database = await checkDatabase(this.config.get<string>(this.options.databaseUrlEnv));
    }
    if (this.options.requireBroker) {
      checks.broker = await checkBroker(this.config.get<string>('RABBITMQ_URL'));
    }
    const ok = Object.values(checks).every((c) => c.ok);
    if (!ok) res.status(503);
    return { status: ok ? 'ready' : 'unavailable', service: this.options.service, checks };
  }
}

@Module({})
export class HealthModule {
  static register(options: HealthOptions): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: HEALTH_OPTIONS, useValue: options }],
    };
  }
}
