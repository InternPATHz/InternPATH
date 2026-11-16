import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../../generated/client';

/** Job database client; connects on the first query and disconnects on shutdown. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      datasourceUrl: config.get<string>('JOB_DATABASE_URL'),
      transactionOptions: { maxWait: 10_000, timeout: 30_000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
