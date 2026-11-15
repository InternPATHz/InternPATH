import { ConfigService } from '@nestjs/config';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import sinon from 'sinon';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { fetchInternal } from '../../src/internal/internal-http.client';
import { JobInternalClient } from '../../src/internal/job-client.service';

describe('Internal API Clients (Unit)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sinon.restore();
  });

  it('JobInternalClient ส่ง request พร้อม Service Token และ correlation ID', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any;

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ reserved: true }), { status: 200 });
    }) as any;

    const jobSecret = 'test-job-service-secret-lifecycle-32-chars-long';
    const config = new ConfigService({
      JOB_URL: 'http://127.0.0.1:3002',
      JOB_SERVICE_SECRET_LIFECYCLE: jobSecret,
    });
    const client = new JobInternalClient(config);

    const result = await client.reserveQuota('job-1', 'app-1', 'corr-1');
    expect(result).to.deep.equal({ reserved: true });
    expect(capturedUrl).to.equal('http://127.0.0.1:3002/internal/v1/jobs/job-1/quota/reserve');
    expect(capturedHeaders['X-Correlation-Id']).to.equal('corr-1');
    expect(capturedBody).to.deep.equal({ application_id: 'app-1' });

    // Bearer ต้องเป็น JWT ที่มี iss='lifecycle', aud='job' และ verify ด้วย secret ได้
    const authHeader = capturedHeaders['Authorization'];
    expect(authHeader).to.be.a('string');
    expect(authHeader).to.match(/^Bearer [A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/);
    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, jobSecret, {
      algorithms: ['HS256'],
      issuer: 'lifecycle',
      audience: 'job',
      complete: true,
    }) as any;
    expect(decoded.header.typ).to.equal('service');
    expect(decoded.payload.iss).to.equal('lifecycle');
    expect(decoded.payload.aud).to.equal('job');
    expect(decoded.payload.jti).to.be.a('string');
  });

  it('IdentityInternalClient ส่ง checkConsent ถูกต้อง', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any;

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ has_consent: true }), { status: 200 });
    }) as any;

    const identitySecret = 'test-identity-service-secret-lifecycle-32-chars-long';
    const config = new ConfigService({
      IDENTITY_URL: 'http://127.0.0.1:3001',
      IDENTITY_SERVICE_SECRET_LIFECYCLE: identitySecret,
    });
    const client = new IdentityInternalClient(config);

    const result = await client.checkConsent('student-1', 'comp-1', 'corr-2');
    expect(result).to.deep.equal({ has_consent: true });
    expect(capturedUrl).to.equal('http://127.0.0.1:3001/internal/v1/consents/check');
    expect(capturedHeaders['X-Correlation-Id']).to.equal('corr-2');
    expect(capturedBody).to.deep.equal({ student_user_id: 'student-1', company_id: 'comp-1' });

    // Bearer ต้องเป็น JWT ที่มี iss='lifecycle', aud='identity' และ verify ด้วย secret ได้
    const authHeader = capturedHeaders['Authorization'];
    expect(authHeader).to.be.a('string');
    expect(authHeader).to.match(/^Bearer [A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/);
    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, identitySecret, {
      algorithms: ['HS256'],
      issuer: 'lifecycle',
      audience: 'identity',
      complete: true,
    }) as any;
    expect(decoded.header.typ).to.equal('service');
    expect(decoded.payload.iss).to.equal('lifecycle');
    expect(decoded.payload.aud).to.equal('identity');
    expect(decoded.payload.jti).to.be.a('string');
  });

  it('fetchInternal retry 2 ครั้งเมื่อเจอรหัส 503 ก่อนล้มเหลว', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response(
        JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Down' } }),
        { status: 503 },
      );
    }) as any;

    try {
      await fetchInternal('http://127.0.0.1:9999/test', { maxRetries: 2, timeoutMs: 1000 });
      expect.fail('ควร throw AppException');
    } catch (err: any) {
      expect(err.code).to.equal('UPSTREAM_UNAVAILABLE');
      expect(callCount).to.equal(3); // attempt 0, 1, 2
    }
  });
});
