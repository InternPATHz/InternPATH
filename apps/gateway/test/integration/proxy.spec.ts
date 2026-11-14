import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureGateway } from '../../src/configure-gateway';
import { DenylistService } from '../../src/denylist/denylist.service';

describe('Gateway proxy and security', function () {
  this.timeout(15_000);
  let upstream: Server;
  let app: INestApplication;
  let privateKey: string;
  let denied: string[] = [];
  const userId = randomUUID();

  const token = () => jwt.sign({ role: 'STUDENT' }, privateKey, {
    algorithm: 'RS256', subject: userId, expiresIn: 900, jwtid: randomUUID(),
  });
  const edge = (call: request.Test) => call.set('X-Edge-Secret', 'edge-test-secret');

  before(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    privateKey = pair.privateKey;
    upstream = createServer((req, res) => {
      if (req.url === '/internal/v1/denylist') {
        const claims = jwt.verify(req.headers.authorization!.slice(7), 'g'.repeat(48),
          { algorithms: ['HS256'], issuer: 'gateway', audience: 'identity', complete: true });
        expect(claims.header.typ).to.equal('service');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(denied.map((id) => ({ user_id: id }))));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8') }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    process.env.IDENTITY_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    for (const name of ['JOB_URL', 'VERIFICATION_URL', 'LIFECYCLE_URL', 'NOTIFICATION_URL'])
      process.env[name] = process.env.IDENTITY_URL;
    process.env.IDENTITY_SERVICE_SECRET_GATEWAY = 'g'.repeat(48);
    process.env.JWT_PUBLIC_KEY = pair.publicKey;
    process.env.EDGE_SHARED_SECRET = 'edge-test-secret';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3100';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureGateway(app);
    await app.init();
    await app.get(DenylistService).refresh();
  });

  after(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    for (const name of ['IDENTITY_URL', 'JOB_URL', 'VERIFICATION_URL', 'LIFECYCLE_URL', 'NOTIFICATION_URL',
      'IDENTITY_SERVICE_SECRET_GATEWAY', 'JWT_PUBLIC_KEY', 'EDGE_SHARED_SECRET', 'CORS_ALLOWED_ORIGINS'])
      delete process.env[name];
  });

  it('forwards a public request with body and query while stripping spoofed identity headers', async () => {
    const result = await edge(request(app.getHttpServer()).post('/api/v1/auth/login?q=1'))
      .set('X-User-Id', 'forged').set('X-Client-IP', '203.0.113.10').send({ email: 'a@example.com' }).expect(200);
    expect(result.body.path).to.equal('/v1/auth/login?q=1');
    expect(result.body.method).to.equal('POST');
    expect(JSON.parse(result.body.body)).to.deep.equal({ email: 'a@example.com' });
    expect(result.body.headers).not.to.have.property('x-user-id');
    expect(result.body.headers['x-forwarded-for']).to.equal('203.0.113.10');
  });

  it('checks JWT and denylist and forwards trusted claims', async () => {
    const noToken = await edge(request(app.getHttpServer()).get('/api/v1/users/me')).expect(401);
    expect(noToken.body.error.code).to.equal('UNAUTHENTICATED');
    const valid = await edge(request(app.getHttpServer()).get('/api/v1/users/me'))
      .set('Authorization', `Bearer ${token()}`).set('X-User-Role', 'PLATFORM_ADMIN').expect(200);
    expect(valid.body.headers['x-user-id']).to.equal(userId);
    expect(valid.body.headers['x-user-role']).to.equal('STUDENT');
    denied = [userId];
    await app.get(DenylistService).refresh();
    const suspended = await edge(request(app.getHttpServer()).get('/api/v1/users/me'))
      .set('Authorization', `Bearer ${token()}`).expect(401);
    expect(suspended.body.error.code).to.equal('ACCOUNT_SUSPENDED');
    denied = [];
    await app.get(DenylistService).refresh();
  });

  it('blocks internal paths, missing edge secret and untrusted browser origins', async () => {
    await edge(request(app.getHttpServer()).get('/api/v1/internal/v1/denylist')).expect(404);
    await request(app.getHttpServer()).get('/api/v1/auth/login').expect(401);
    await edge(request(app.getHttpServer()).get('/api/v1/public/certificates/abc'))
      .set('Origin', 'https://untrusted.test').expect(403);
    const preflight = await request(app.getHttpServer()).options('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3100').expect(204);
    expect(preflight.headers['access-control-allow-origin']).to.equal('http://localhost:3100');
  });

  it('limits repeated login attempts per trusted client IP', async () => {
    for (let index = 0; index < 10; index++) await edge(request(app.getHttpServer()).post('/api/v1/auth/login'))
      .set('X-Client-IP', '203.0.113.77').send({ email: 'a@example.com' }).expect(200);
    const limited = await edge(request(app.getHttpServer()).post('/api/v1/auth/login'))
      .set('X-Client-IP', '203.0.113.77').send({ email: 'a@example.com' }).expect(429);
    expect(limited.body.error.code).to.equal('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).to.be.greaterThan(0);
  });
});
