import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LIFECYCLE_DEFAULTS, LifecycleConfigKey } from './lifecycle.constants';

@Injectable()
export class LifecycleConfigService {
  constructor(
    private readonly envConfig: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * ดึงค่า config (ลำดับความสำคัญ: config_overrides ใน DB -> env -> ค่าเริ่มต้น)
   */
  async getNumber(key: LifecycleConfigKey): Promise<number> {
    if (this.prisma) {
      try {
        const override = await this.prisma.configOverride.findUnique({
          where: { key },
        });
        if (override) {
          const parsed = Number(override.value);
          if (!Number.isNaN(parsed)) return parsed;
        }
      } catch {
        // เมื่อ DB ยังไม่พร้อมหรือไม่สามารถต่อได้ ให้ใช้ fallback
      }
    }

    const fromEnv = this.envConfig.get<string>(key);
    if (fromEnv !== undefined && fromEnv !== '') {
      const parsed = Number(fromEnv);
      if (!Number.isNaN(parsed)) return parsed;
    }

    return LIFECYCLE_DEFAULTS[key];
  }

  /**
   * บันทึกหรืออัปเดต override ใน DB เพื่อเร่งเวลาทดสอบ UAT
   */
  async setOverride(key: string, value: string, description?: string): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.configOverride.upsert({
      where: { key },
      create: { key, value, description },
      update: { value, description },
    });
  }

  /**
   * ลบ override ออก เพื่อคืนสู่ค่าเริ่มต้น
   */
  async removeOverride(key: string): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.configOverride.deleteMany({
      where: { key },
    });
  }
}
