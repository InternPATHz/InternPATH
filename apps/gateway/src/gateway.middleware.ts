import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { normalizePemKey, type JwtClaims } from '@internpath/common';
import type { Request, Response } from 'express';
import { AccessTokenError, verifyAccessToken } from './auth/verify-access-token';
import { DenylistService } from './denylist/denylist.service';
import { RateLimiter } from './rate-limit/rate-limiter';
import { isPublicRoute, publicReadRoute, resolveService, ServiceName } from './routing/routing';

const URL_ENV: Record<ServiceName, string> = {
  identity: 'IDENTITY_URL', job: 'JOB_URL', verification: 'VERIFICATION_URL',
  lifecycle: 'LIFECYCLE_URL', notification: 'NOTIFICATION_URL',
};
/** api-contract §3: public read responses are identical for every caller, so shared caches may keep them. */
const PUBLIC_READ_CACHE = 'public, max-age=60';
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

export class GatewayMiddleware {
  private readonly rateLimiter = new RateLimiter();

  constructor(private readonly config: ConfigService, private readonly denylist: DenylistService) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    const raw = req.originalUrl.slice('/api/v1'.length);
    const path = raw.split('?')[0];
    if (!path.startsWith('/') || /%|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/i.test(path))
      return this.error(req, res, 400, 'VALIDATION_FAILED');
    const origin = req.headers.origin;
    const allowedOrigins = (this.config.get<string>('CORS_ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    if (origin) {
      if (!allowedOrigins.includes(origin)) return this.error(req, res, 403, 'FORBIDDEN_ROLE');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Correlation-Id, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    const edgeSecret = this.config.get<string>('EDGE_SHARED_SECRET');
    const supplied = req.headers['x-edge-secret'];
    const validEdge = !!edgeSecret && typeof supplied === 'string' && this.equal(supplied, edgeSecret);
    if (edgeSecret && !validEdge) return this.error(req, res, 401, 'UNAUTHENTICATED');
    const clientIp = validEdge && typeof req.headers['x-client-ip'] === 'string' && isIP(req.headers['x-client-ip'])
      ? req.headers['x-client-ip'] : req.socket.remoteAddress ?? 'unknown';

    const service = resolveService(path);
    if (!service) return this.error(req, res, 404, 'NOT_FOUND');
    const publicRoute = isPublicRoute(req.method, path);
    let user: JwtClaims | undefined;
    if (!publicRoute) {
      if (typeof req.headers.authorization !== 'string') return this.error(req, res, 401, 'UNAUTHENTICATED');
      const key = normalizePemKey(this.config.get<string>('JWT_PUBLIC_KEY'));
      if (!key) return this.error(req, res, 503, 'UPSTREAM_UNAVAILABLE');
      try {
        user = verifyAccessToken(req.headers.authorization, key);
      } catch (error) {
        return this.error(req, res, 401, error instanceof AccessTokenError ? error.code : 'UNAUTHENTICATED');
      }
      if (!this.denylist.isFresh()) return this.error(req, res, 503, 'UPSTREAM_UNAVAILABLE');
      if (this.denylist.has(user.sub)) return this.error(req, res, 401, 'ACCOUNT_SUSPENDED');
    }

    const rate = this.rateLimiter.rule(req.method, path);
    let body: Buffer | undefined;
    if (rate) {
      const retry = rate.name === 'advisor-create-student' && user
        ? this.rateLimiter.checkAdvisorCreateIp(clientIp) || this.rateLimiter.checkActor(rate, user.sub)
        : this.rateLimiter.checkIp(rate, clientIp);
      if (retry) { res.setHeader('Retry-After', String(retry)); return this.error(req, res, 429, 'RATE_LIMITED'); }
      if (req.method === 'POST' && path.startsWith('/auth/')) {
        try { body = await this.rateLimiter.readAuthBody(req); }
        catch {
          if (!res.destroyed) this.error(req, res, 413, 'VALIDATION_FAILED');
          return;
        }
        const accountRetry = this.rateLimiter.checkAccount(rate, path, body);
        if (accountRetry) {
          res.setHeader('Retry-After', String(accountRetry));
          return this.error(req, res, 429, 'RATE_LIMITED');
        }
      }
    }
    this.proxy(req, res, service, raw, clientIp, user, body, publicReadRoute(req.method, path) !== undefined);
  };

  private proxy(req: Request, res: Response, service: ServiceName, raw: string, clientIp: string,
    user?: JwtClaims, body?: Buffer, publicRead = false): void {
    let base: URL;
    try {
      base = new URL(this.config.get<string>(URL_ENV[service]) ?? '');
      if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash || base.username)
        throw new Error('Invalid upstream');
    } catch { return this.error(req, res, 503, 'UPSTREAM_UNAVAILABLE'); }
    const target = new URL(`/v1${raw}`, base);
    const headers = { ...req.headers };
    for (const name of [...HOP_HEADERS, 'x-edge-secret', 'x-client-ip', 'x-user-id', 'x-user-role',
      'x-company-id', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) delete headers[name];
    headers.host = target.host;
    headers['x-forwarded-for'] = clientIp;
    if (user) {
      headers['x-user-id'] = user.sub;
      headers['x-user-role'] = user.role;
      if (user.company_id) headers['x-company-id'] = user.company_id;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request(target, { method: req.method, headers, timeout: 10_000 }, (response) => {
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !HOP_HEADERS.includes(name) && name !== 'x-correlation-id') res.setHeader(name, value);
      }
      const status = response.statusCode ?? 502;
      // Only cache successes; errors (404 for an unverified company, 5xx) must not stick for a minute.
      if (publicRead) res.setHeader('Cache-Control', status >= 200 && status < 300 ? PUBLIC_READ_CACHE : 'no-store');
      res.status(status);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) this.error(req, res, 502, 'UPSTREAM_UNAVAILABLE');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    if (body) upstream.end(body);
    else req.pipe(upstream);
  }

  private equal(a: string, b: string): boolean {
    const left = Buffer.from(a); const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private error(req: Request, res: Response, status: number, code: string): void {
    const messages: Record<number, string> = { 400: 'ข้อมูลไม่ถูกต้อง', 401: 'ต้องเข้าสู่ระบบก่อน', 403: 'ไม่มีสิทธิ์',
      413: 'ข้อมูลมีขนาดใหญ่เกินไป',
      404: 'ไม่พบข้อมูล', 429: 'ส่งคำขอบ่อยเกินไป', 503: 'บริการไม่พร้อมใช้งาน' };
    res.status(status).json({ error: { code, message: messages[status], correlation_id: req.headers['x-correlation-id'] } });
  }
}
