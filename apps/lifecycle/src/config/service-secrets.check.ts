import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IDENTITY_SERVICE_SECRET_ENV } from '../internal/identity-client.service';
import { JOB_SERVICE_SECRET_ENV } from '../internal/job-client.service';

/** ความยาวขั้นต่ำเดียวกับ `signServiceToken` ของ libs/common */
export const MIN_SERVICE_SECRET_LENGTH = 32;

/** secret ที่ Lifecycle ใช้เซ็น token เรียก Service อื่น — ขาดตัวไหน `GET /me/profile`, `POST /applications` ฯลฯ จะ 500 */
export const REQUIRED_OUTBOUND_SECRETS = [IDENTITY_SERVICE_SECRET_ENV, JOB_SERVICE_SECRET_ENV] as const;

/** คืนชื่อ env ที่ว่างหรือสั้นกว่าเกณฑ์ (ไม่คืนค่า secret) */
export function missingServiceSecrets(read: (name: string) => string | undefined): string[] {
  return REQUIRED_OUTBOUND_SECRETS.filter((name) => (read(name)?.length ?? 0) < MIN_SERVICE_SECRET_LENGTH);
}

/**
 * Fail-fast ตอนเริ่มระบบ (PM ขอ 2026-11-18) — แทนที่จะไปเจอ 500 `AUTH_NOT_CONFIGURED` ตอนผู้ใช้เรียก API
 * โหลดเฉพาะใน `LifecycleModule` (แอปจริง) — เทสต์ที่ตั้ง `DISABLE_INFRA=true` ไม่โหลด
 */
@Injectable()
export class ServiceSecretsCheck implements OnModuleInit {
  private readonly logger = new Logger(ServiceSecretsCheck.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const missing = missingServiceSecrets((name) => this.config.get<string>(name));
    if (missing.length) {
      const message = `Lifecycle ไม่เริ่ม: ต้องตั้ง ${missing.join(', ')} (≥ ${MIN_SERVICE_SECRET_LENGTH} ตัวอักษร ให้ตรงกับ Service ปลายทาง — ดู .env.example)`;
      this.logger.error(message);
      throw new Error(message);
    }
  }
}
