import type { ServiceName } from '@internpath/contracts';
import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
  Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxRelay } from '../outbox/outbox-relay';
import { OutboxWriter } from '../outbox/outbox-writer';
import { PgRelayDb } from '../outbox/pg-relay-db';
import { BrokerConnection } from './broker-connection';
import { EventConsumer, type EventConsumerOptions, type ProcessedEventsTx } from './event-consumer';

export const MESSAGING_OPTIONS = 'MESSAGING_OPTIONS';
export const RELAY_FACTORY = 'MESSAGING_RELAY_FACTORY';

export interface MessagingModuleOptions<Tx extends ProcessedEventsTx = ProcessedEventsTx> {
  service: ServiceName;
  /** ใส่เมื่อ Service นี้ publish Event: เริ่ม relay โดยอ่าน DB URL จาก env ชื่อนี้ (ใช้ `<PREFIX>_DIRECT_URL`) */
  publishes?: { databaseUrlEnv: string };
  /**
   * ใส่เมื่อ Service นี้รับ Event: เปิด EventConsumer
   * ใช้รูปแบบ `{ inject, useFactory }` เมื่อต้องใช้ provider ที่ฉีดผ่าน DI เช่น PrismaService
   * (ใส่โมดูลของ provider นั้นใน `imports` ด้วย)
   */
  consumes?: Omit<EventConsumerOptions<Tx>, 'service'> | MessagingConsumesFactory<Tx>;
  imports?: NonNullable<DynamicModule['imports']>;
}

export interface MessagingConsumesFactory<Tx extends ProcessedEventsTx = ProcessedEventsTx> {
  inject?: any[];
  useFactory: (
    ...deps: any[]
  ) => Omit<EventConsumerOptions<Tx>, 'service'> | Promise<Omit<EventConsumerOptions<Tx>, 'service'>>;
}

export interface RelayHandle {
  start(): void;
  stop(): Promise<void>;
}
export type RelayFactory = (a: {
  broker: BrokerConnection;
  databaseUrl: string;
  service: ServiceName;
}) => Promise<RelayHandle>;

export const defaultRelayFactory: RelayFactory = async ({ broker, databaseUrl, service }) => {
  const db = new PgRelayDb(databaseUrl);
  const relay = new OutboxRelay({ service, db, publisher: broker });
  return {
    start: () => relay.start(),
    stop: async () => {
      await relay.stop();
      await db.close();
    },
  };
};

@Injectable()
export class MessagingLifecycle implements OnModuleInit, OnApplicationShutdown {
  private relay?: RelayHandle;

  constructor(
    @Inject(MESSAGING_OPTIONS) private readonly options: MessagingModuleOptions,
    private readonly broker: BrokerConnection,
    private readonly config: ConfigService,
    @Inject(RELAY_FACTORY) private readonly relayFactory: RelayFactory,
    @Optional() private readonly consumer?: EventConsumer<ProcessedEventsTx>,
  ) {}

  async onModuleInit(): Promise<void> {
    const { publishes, service } = this.options;
    let databaseUrl: string | undefined;
    if (publishes) {
      databaseUrl = this.config.get<string>(publishes.databaseUrlEnv);
      if (!databaseUrl) {
        throw new Error(`MessagingModule: ${publishes.databaseUrlEnv} is not configured`);
      }
    }
    // ต่อครั้งแรกล้มเหลว = Service ไม่ควรขึ้น (ให้ Docker restart) ส่วนหลุดภายหลังต่อใหม่เอง
    await this.broker.connect();
    if (databaseUrl) {
      this.relay = await this.relayFactory({ broker: this.broker, databaseUrl, service });
      this.relay.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay?.stop();
    await this.consumer?.close();
    await this.broker.close();
  }
}

@Global()
@Module({})
export class MessagingModule {
  static register<Tx extends ProcessedEventsTx = ProcessedEventsTx>(
    options: MessagingModuleOptions<Tx>,
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: MESSAGING_OPTIONS, useValue: options },
      {
        provide: BrokerConnection,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => {
          const url = config.get<string>('RABBITMQ_URL');
          if (!url) throw new Error('MessagingModule: RABBITMQ_URL is not configured');
          return new BrokerConnection({ url });
        },
      },
      { provide: RELAY_FACTORY, useValue: defaultRelayFactory },
      OutboxWriter,
      MessagingLifecycle,
    ];
    const exported: Array<typeof OutboxWriter | typeof BrokerConnection | typeof EventConsumer> = [
      OutboxWriter,
      BrokerConnection,
    ];
    if (options.consumes) {
      const consumes = options.consumes;
      providers.push(
        'useFactory' in consumes
          ? {
              provide: EventConsumer,
              inject: [BrokerConnection, ...(consumes.inject ?? [])],
              useFactory: async (broker: BrokerConnection, ...deps: unknown[]) =>
                new EventConsumer<Tx>(broker, { service: options.service, ...(await consumes.useFactory(...deps)) }),
            }
          : {
              provide: EventConsumer,
              inject: [BrokerConnection],
              useFactory: (broker: BrokerConnection) =>
                new EventConsumer<Tx>(broker, { service: options.service, ...consumes }),
            },
      );
      exported.push(EventConsumer);
    }
    return { module: MessagingModule, global: true, imports: options.imports, providers, exports: exported };
  }
}
