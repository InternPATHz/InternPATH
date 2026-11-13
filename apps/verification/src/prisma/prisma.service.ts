import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/** PrismaClient ของ verification_db (เชื่อมต่อแบบ lazy; ปิดตอน shutdown) */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      datasourceUrl: config.get<string>('VERIFICATION_DATABASE_URL'),
      // ค่าเริ่มต้นของ Prisma (รอ connection 2 วินาที / Transaction 5 วินาที) แคบเกินไปเมื่อมีหลาย Event ประมวลผลพร้อมกัน
      transactionOptions: { maxWait: 10_000, timeout: 30_000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
