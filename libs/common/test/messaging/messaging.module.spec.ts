import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { expect } from 'chai';
import {
  BrokerConnection,
  EventConsumer,
  MessagingModule,
  OutboxWriter,
  RELAY_FACTORY,
  type MessagingModuleOptions,
} from '../../src';

function fakeBroker() {
  const s = { connects: 0, closes: 0 };
  const broker: any = {
    connect: async () => void s.connects++,
    close: async () => void s.closes++,
    onConnected: () => undefined,
    isConnected: () => true,
    createChannel: async () => ({}),
    publish: async () => undefined,
  };
  return { broker, s };
}

function fakeRelay() {
  const s = { started: 0, stopped: 0 };
  const relay = {
    start: () => void s.started++,
    stop: async () => void s.stopped++,
  };
  return { relay, s };
}

const config = (values: Record<string, string>) =>
  ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => values] });

async function build(
  options: MessagingModuleOptions,
  values: Record<string, string> = { RABBITMQ_URL: 'amqp://x', JOB_DIRECT_URL: 'postgresql://x' },
) {
  const b = fakeBroker();
  const r = fakeRelay();
  let relayFactoryCalls = 0;
  const mod: TestingModule = await Test.createTestingModule({
    imports: [config(values), MessagingModule.register(options)],
  })
    .overrideProvider(BrokerConnection)
    .useValue(b.broker)
    .overrideProvider(RELAY_FACTORY)
    .useValue(async () => {
      relayFactoryCalls++;
      return r.relay;
    })
    .compile();
  return { mod, b, r, relayFactoryCalls: () => relayFactoryCalls };
}

describe('MessagingModule', () => {
  it('register({ service, publishes }) เริ่ม relay ตอน module init และ stop + ปิด connection ตอน shutdown', async () => {
    const { mod, b, r } = await build({ service: 'job', publishes: { databaseUrlEnv: 'JOB_DIRECT_URL' } });
    await mod.init();
    expect(b.s.connects).to.equal(1);
    expect(r.s.started).to.equal(1);
    expect(mod.get(OutboxWriter)).to.be.instanceOf(OutboxWriter);
    await mod.close();
    expect(r.s.stopped).to.equal(1);
    expect(b.s.closes).to.equal(1);
  });

  it('ไม่ใส่ publishes: ไม่มี relay ถูกสร้าง/เริ่ม', async () => {
    const { mod, r, relayFactoryCalls } = await build({ service: 'notification' });
    await mod.init();
    expect(relayFactoryCalls()).to.equal(0);
    expect(r.s.started).to.equal(0);
    await mod.close();
  });

  it('ใส่ consumes: inject EventConsumer ได้; ไม่ใส่: ไม่มี provider', async () => {
    const withC = await build({
      service: 'notification',
      consumes: { runInTransaction: async (fn) => fn({ processedEvent: { createMany: async () => ({ count: 1 }) } }) },
    });
    await withC.mod.init();
    expect(withC.mod.get(EventConsumer)).to.be.instanceOf(EventConsumer);
    await withC.mod.close();

    const without = await build({ service: 'notification' });
    expect(() => without.mod.get(EventConsumer, { strict: false })).to.throw();
    await without.mod.close();
  });

  it('ไม่มี RABBITMQ_URL: ล้มพร้อมข้อความที่ระบุชื่อตัวแปร', async () => {
    const saved = process.env.RABBITMQ_URL;
    delete process.env.RABBITMQ_URL;
    try {
      let err: Error | undefined;
      try {
        await Test.createTestingModule({
          imports: [config({}), MessagingModule.register({ service: 'job' })],
        }).compile();
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.include('RABBITMQ_URL');
    } finally {
      if (saved !== undefined) process.env.RABBITMQ_URL = saved;
    }
  });

  it('publishes ที่ชื่อตัวแปร DB ไม่มีค่า: init ล้มพร้อมชื่อตัวแปร', async () => {
    const { mod } = await build({ service: 'job', publishes: { databaseUrlEnv: 'NOPE_DIRECT_URL' } });
    let err: Error | undefined;
    try {
      await mod.init();
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.include('NOPE_DIRECT_URL');
  });
});
