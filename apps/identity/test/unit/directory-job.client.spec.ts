import { randomUUID } from 'node:crypto';
import { AppException } from '@internpath/common';
import { ConfigService } from '@nestjs/config';
import { expect } from 'chai';
import { DirectoryJobClient } from '../../src/modules/directory/directory-job.client';

const secret = 'identity-to-job-directory-test-secret-long-enough';
const page = (company_ids: string[], next_cursor: string | null) =>
  new Response(JSON.stringify({ company_ids, next_cursor }), { status: 200 });

describe('Directory Job client', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('collects all pages and signs an Identity service token', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const requests: string[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push(String(input));
      expect(init?.headers).to.have.property('authorization').that.matches(/^Bearer /);
      return requests.length === 1 ? page([first], first) : page([second], null);
    };
    const client = new DirectoryJobClient(new ConfigService({ JOB_SERVICE_SECRET_IDENTITY: secret,
      JOB_URL: 'http://job:3002' }));
    expect([...await client.companyIds('TECH_IT')]).to.deep.equal([first, second]);
    expect(requests[0]).to.equal('http://job:3002/internal/v1/directory/company-ids?category=TECH_IT');
    expect(requests[1]).to.include(`after=${first}`);
  });

  it('fails closed if Job is unavailable or returns an invalid page', async () => {
    const client = new DirectoryJobClient(new ConfigService({ JOB_SERVICE_SECRET_IDENTITY: secret }));
    for (const fetcher of [
      async () => { throw new Error('offline'); },
      async () => new Response('', { status: 503 }),
      async () => page(['not-a-uuid'], null),
      async () => page([], randomUUID()),
    ]) {
      globalThis.fetch = fetcher as typeof fetch;
      const error = await client.companyIds('TECH_IT').then(() => null, (cause: unknown) => cause);
      expect(error).to.be.instanceOf(AppException);
      expect((error as AppException).getStatus()).to.equal(503);
    }
    const missingSecret = new DirectoryJobClient(new ConfigService({}));
    const error = await missingSecret.companyIds('TECH_IT').then(() => null, (cause: unknown) => cause);
    expect((error as AppException).getStatus()).to.equal(503);
  });
});
