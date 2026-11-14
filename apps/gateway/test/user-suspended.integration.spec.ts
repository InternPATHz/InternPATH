import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { ConfigService } from '@nestjs/config';
import { BrokerConnection } from '@internpath/common';
import { EVENTS_EXCHANGE, routingKey } from '@internpath/contracts';
import { DenylistService } from '../src/denylist.service';
import { UserSuspendedConsumer } from '../src/user-suspended.consumer';

const live = process.env.RUN_RABBITMQ_TESTS === 'true' ? describe : describe.skip;

live('Gateway UserSuspended RabbitMQ integration', () => {
  let consumer: UserSuspendedConsumer;
  let publisher: BrokerConnection;
  let denylist: DenylistService;

  before(async () => {
    const url = process.env.RABBITMQ_URL;
    if (!url) throw new Error('RABBITMQ_URL is required for live test');
    denylist = new DenylistService(new ConfigService());
    consumer = new UserSuspendedConsumer(new ConfigService({ RABBITMQ_URL: url }), denylist);
    await consumer.onModuleInit();
    publisher = new BrokerConnection({ url });
    await publisher.connect();
  });

  after(async () => {
    await consumer?.onApplicationShutdown();
    await publisher?.close();
  });

  it('updates the Gateway cache from E16 deliveries', async () => {
    const userId = randomUUID();
    const publish = async (version: number, suspended: boolean): Promise<void> => {
      const event = {
        event_id: randomUUID(), type: 'UserSuspended', version: 1,
        occurred_at: new Date().toISOString(), correlation_id: randomUUID(), producer: 'identity',
        payload: { user_id: userId, suspended, entity_version: version, at: new Date().toISOString() },
      };
      await publisher.publish(EVENTS_EXCHANGE, routingKey('identity', 'UserSuspended'),
        Buffer.from(JSON.stringify(event)), { contentType: 'application/json', deliveryMode: 2 });
    };
    const waitFor = async (expected: boolean): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (denylist.has(userId) !== expected && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(denylist.has(userId)).to.equal(expected);
    };
    await publish(1, true);
    await waitFor(true);
    await publish(2, false);
    await waitFor(false);
  });
});
