import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../../generated/client';

/** identity_db client; เชื่อมต่อเมื่อ query แรกและปิดเมื่อแอปหยุด */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      datasourceUrl: config.get<string>('IDENTITY_DATABASE_URL'),
      transactionOptions: { maxWait: 10_000, timeout: 30_000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
