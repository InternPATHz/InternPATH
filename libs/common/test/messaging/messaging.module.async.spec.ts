import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import { BrokerConnection, EventConsumer, MessagingModule, RELAY_FACTORY } from '../../src';

/** แทน PrismaService ที่ Service จริงฉีดผ่าน DI */
@Injectable()
class FakeDb {
  transactions = 0;
  async tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    this.transactions++;
    return fn({ processedEvent: { createMany: async () => ({ count: 1 }) } });
  }
}

@Module({ providers: [FakeDb], exports: [FakeDb] })
class DbModule {}

describe('MessagingModule consumes แบบ factory + inject (ผลรีวิว)', () => {
  it('สร้าง EventConsumer จาก dependency ที่ฉีดผ่าน DI (เช่น PrismaService) ได้', async () => {
    const broker: any = {
      connect: async () => undefined,
      close: async () => undefined,
      onConnected: () => undefined,
      isConnected: () => false,
      createChannel: async () => ({}),
      publish: async () => undefined,
    };
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ RABBITMQ_URL: 'amqp://x' })] }),
        DbModule,
        MessagingModule.register({
          service: 'notification',
          imports: [DbModule],
          consumes: {
            inject: [FakeDb],
            useFactory: (db: FakeDb) => ({ runInTransaction: (fn) => db.tx(fn) }),
          },
        }),
      ],
    })
      .overrideProvider(BrokerConnection)
      .useValue(broker)
      .overrideProvider(RELAY_FACTORY)
      .useValue(async () => ({ start: () => undefined, stop: async () => undefined }))
      .compile();
    await mod.init();

    const consumer = mod.get(EventConsumer);
    expect(consumer).to.be.instanceOf(EventConsumer);
    // runInTransaction ที่ได้ต้องเป็นตัวที่ factory สร้างจาก FakeDb จริง
    await (consumer as any).o.runInTransaction(async () => undefined);
    expect(mod.get(FakeDb).transactions).to.equal(1);
    await mod.close();
  });
});
