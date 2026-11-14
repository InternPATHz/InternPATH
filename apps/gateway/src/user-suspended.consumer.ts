import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrokerConnection, EventConsumer, type ProcessedEventsTx } from '@internpath/common';
import type { ServiceName, UserSuspendedPayload } from '@internpath/contracts';
import { DenylistService } from './denylist.service';

// Gateway has no database. The entity version makes replayed events safe, while this
// process-local marker avoids repeated work until the next restart and full HTTP pull.
class GatewayEventStore {
  private readonly seen = new Set<string>();

  async runInTransaction<T>(fn: (tx: ProcessedEventsTx) => Promise<T>): Promise<T> {
    const additions = new Set<string>();
    const tx: ProcessedEventsTx = {
      processedEvent: {
        createMany: async ({ data }) => {
          const key = `${data[0].consumer}:${data[0].eventId}`;
          if (this.seen.has(key) || additions.has(key)) return { count: 0 };
          additions.add(key);
          return { count: 1 };
        },
      },
    };
    const result = await fn(tx);
    for (const key of additions) this.seen.add(key);
    return result;
  }
}

@Injectable()
export class UserSuspendedConsumer implements OnModuleInit, OnApplicationShutdown {
  private broker?: BrokerConnection;
  private consumer?: EventConsumer<ProcessedEventsTx>;
  private readonly store = new GatewayEventStore();

  constructor(private readonly config: ConfigService, private readonly denylist: DenylistService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) throw new Error('Gateway: RABBITMQ_URL is not configured');
    this.broker = new BrokerConnection({ url });
    await this.broker.connect();
    this.consumer = new EventConsumer(this.broker, {
      // ServiceName lists event producers; Gateway is a consumer-only service.
      service: 'gateway' as ServiceName,
      runInTransaction: (fn) => this.store.runInTransaction(fn),
    });
    await this.consumer.subscribe<UserSuspendedPayload>({
      producer: 'identity',
      type: 'UserSuspended',
      handler: async (event) => { this.denylist.applyEvent(event.payload); },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.close();
    await this.broker?.close();
  }
}
