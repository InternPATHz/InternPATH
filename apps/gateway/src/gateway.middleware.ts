import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { ConfigService } from '@nestjs/config';
import type { JwtClaims } from '@internpath/common';
import * as jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { DenylistService } from './denylist/denylist.service';
import { isPublicRoute, resolveService, ServiceName } from './routing/routing';

const URL_ENV: Record<ServiceName, string> = {
  identity: 'IDENTITY_URL', job: 'JOB_URL', verification: 'VERIFICATION_URL',
  lifecycle: 'LIFECYCLE_URL', notification: 'NOTIFICATION_URL',
};
const ROLES = new Set(['STUDENT', 'COMPANY_HR', 'ADVISOR', 'PLATFORM_ADMIN']);
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

type Limit = { count: number; resetAt: number };

export class GatewayMiddleware {
  private readonly limits = new Map<string, Limit>();

  constructor(private readonly config: ConfigService, private readonly denylist: DenylistService) {}

  handle = (req: Request, res: Response): void => {
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
      const bearer = req.headers.authorization;
      if (typeof bearer !== 'string' || !/^Bearer [^ ]+$/.test(bearer)) return this.error(req, res, 401, 'UNAUTHENTICATED');
      const key = (this.config.get<string>('JWT_PUBLIC_KEY') ?? '').replace(/\\n/g, '\n');
      if (!key) return this.error(req, res, 503, 'UPSTREAM_UNAVAILABLE');
      try {
        const claims = jwt.verify(bearer.slice(7), key, { algorithms: ['RS256'] });
        if (typeof claims !== 'object' || !claims.sub || !ROLES.has(claims.role) ||
            typeof claims.jti !== 'string' || !claims.jti) throw new Error('Invalid claims');
        user = claims as JwtClaims;
      } catch (err) {
        return this.error(req, res, 401, err instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
      }
      if (!this.denylist.isFresh()) return this.error(req, res, 503, 'UPSTREAM_UNAVAILABLE');
      if (this.denylist.has(user.sub)) return this.error(req, res, 401, 'ACCOUNT_SUSPENDED');
    }

    const rate = this.rateRule(req.method, path);
    if (rate) {
      const retry = this.limit(`${rate.name}:${clientIp}`, rate.max, rate.windowMs);
      if (retry) { res.setHeader('Retry-After', String(retry)); return this.error(req, res, 429, 'RATE_LIMITED'); }
    }
    this.proxy(req, res, service, raw, clientIp, user);
  };

  private rateRule(method: string, path: string): { name: string; max: number; windowMs: number } | undefined {
    // README §5.7 fixes categories; these conservative defaults can be tuned by env later.
    if (method === 'POST' && path === '/auth/login') return { name: 'login', max: 10, windowMs: 60_000 };
    if (method === 'POST' && path.startsWith('/auth/register/')) return { name: 'register', max: 5, windowMs: 3_600_000 };
    if (method === 'POST' && ['/auth/password/forgot', '/auth/password/reset', '/auth/resend-verification'].includes(path))
      return { name: 'account-recovery', max: 5, windowMs: 3_600_000 };
    if (method === 'GET' && /^\/public\/certificates\/[^/]+(?:\/verify-hash)?$/.test(path))
      return { name: 'certificate', max: 30, windowMs: 60_000 };
    return undefined;
  }

  private limit(key: string, max: number, windowMs: number): number {
    const now = Date.now();
    const previous = this.limits.get(key);
    if (!previous || now >= previous.resetAt) {
      if (this.limits.size >= 10_000) for (const [name, value] of this.limits) if (value.resetAt <= now) this.limits.delete(name);
      if (this.limits.size >= 10_000 && !previous) return 60;
      this.limits.set(key, { count: 1, resetAt: now + windowMs }); return 0;
    }
    if (previous.count >= max) return Math.ceil((previous.resetAt - now) / 1000);
    previous.count++;
    return 0;
  }

  private proxy(req: Request, res: Response, service: ServiceName, raw: string, clientIp: string, user?: JwtClaims): void {
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
      res.status(response.statusCode ?? 502);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) this.error(req, res, 502, 'UPSTREAM_UNAVAILABLE');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  private equal(a: string, b: string): boolean {
    const left = Buffer.from(a); const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private error(req: Request, res: Response, status: number, code: string): void {
    const messages: Record<number, string> = { 400: 'ข้อมูลไม่ถูกต้อง', 401: 'ต้องเข้าสู่ระบบก่อน', 403: 'ไม่มีสิทธิ์',
      404: 'ไม่พบข้อมูล', 429: 'ส่งคำขอบ่อยเกินไป', 503: 'บริการไม่พร้อมใช้งาน' };
    res.status(status).json({ error: { code, message: messages[status], correlation_id: req.headers['x-correlation-id'] } });
  }
}
