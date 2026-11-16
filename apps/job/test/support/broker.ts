import { randomBytes } from 'node:crypto';

export interface BrokerSandbox {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** A private vhost keeps the real job.* topology and all test traffic off shared queues. */
export async function createBrokerSandboxOrSkip(ctx: Mocha.Context): Promise<BrokerSandbox> {
  if (!process.env.RABBITMQ_URL) {
    console.warn('Job RabbitMQ tests pending: RABBITMQ_URL is not configured.');
    ctx.skip();
  }
  let broker: URL;
  let admin: URL;
  try {
    broker = new URL(process.env.RABBITMQ_URL!);
    admin = new URL(process.env.JOB_IT_RABBITMQ_ADMIN_URL ?? `http://${broker.hostname}:15672`);
  } catch {
    throw new Error('Invalid local RabbitMQ test configuration (values hidden)');
  }
  const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!loopback(broker.hostname) || !loopback(admin.hostname)) {
    console.warn('Job RabbitMQ tests pending: only loopback test infrastructure is allowed.');
    ctx.skip();
  }
  if (
    !['amqp:', 'amqps:'].includes(broker.protocol) ||
    !broker.username ||
    broker.search ||
    broker.hash ||
    !['http:', 'https:'].includes(admin.protocol) ||
    admin.pathname !== '/' ||
    admin.search ||
    admin.hash ||
    admin.username ||
    admin.password
  ) {
    throw new Error('Unsafe local RabbitMQ test configuration (values hidden)');
  }
  const username = decodeURIComponent(broker.username);
  const authorization = `Basic ${Buffer.from(`${username}:${decodeURIComponent(broker.password)}`).toString('base64')}`;
  const request = async (route: string, method = 'GET', data?: unknown) => {
    try {
      return await fetch(new URL(route, admin), {
        method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error('Local RabbitMQ test management request failed (connection details hidden)');
    }
  };
  let available: Response;
  try {
    available = await request('/api/whoami');
  } catch {
    console.warn('Job RabbitMQ tests pending: local management API is unavailable.');
    ctx.skip();
  }
  if (!available!.ok)
    throw new Error(`RabbitMQ test-admin authentication failed (HTTP ${available!.status})`);

  const name = `job_it_${randomBytes(8).toString('hex')}`;
  const route = `/api/vhosts/${encodeURIComponent(name)}`;
  if ((await request(route)).status !== 404)
    throw new Error('Refusing a pre-existing RabbitMQ test vhost');
  let owned = false;
  const drop = async (): Promise<void> => {
    if (!owned) return;
    if (!/^job_it_[0-9a-f]{16}$/.test(name)) throw new Error('Refusing a non-test RabbitMQ vhost');
    const response = await request(route, 'DELETE');
    if (!response.ok && response.status !== 404)
      throw new Error(`RabbitMQ test vhost cleanup failed (HTTP ${response.status})`);
    owned = false;
  };
  try {
    const created = await request(route, 'PUT', {});
    if (!created.ok)
      throw new Error(`RabbitMQ test vhost creation failed (HTTP ${created.status})`);
    owned = true;
    const permission = await request(
      `/api/permissions/${encodeURIComponent(name)}/${encodeURIComponent(username)}`,
      'PUT',
      { configure: '.*', write: '.*', read: '.*' },
    );
    if (!permission.ok)
      throw new Error(`RabbitMQ test permissions failed (HTTP ${permission.status})`);
    broker.pathname = `/${name}`;
    return { name, url: broker.toString(), drop };
  } catch (error) {
    await drop();
    throw error;
  }
}
