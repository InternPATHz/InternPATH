import { createHash } from 'node:crypto';
import type { Request } from 'express';

type Limit = { count: number; resetAt: number };
type Rule = { name: string; max: number; windowMs: number };

export class RateLimiter {
  private readonly limits = new Map<string, Limit>();

  rule(method: string, path: string): Rule | undefined {
    // README §5.7 fixes categories; these conservative defaults can be tuned by env later.
    if (method === 'POST' && path === '/auth/login') return { name: 'login', max: 10, windowMs: 60_000 };
    if (method === 'POST' && path.startsWith('/auth/register/')) return { name: 'register', max: 5, windowMs: 3_600_000 };
    if (method === 'POST' && ['/auth/password/forgot', '/auth/password/reset', '/auth/resend-verification',
      '/auth/login/unlock/request'].includes(path))
      return { name: 'account-recovery', max: 5, windowMs: 3_600_000 };
    if (method === 'GET' && /^\/public\/certificates\/[^/]+(?:\/verify-hash)?$/.test(path))
      return { name: 'certificate', max: 30, windowMs: 60_000 };
    return undefined;
  }

  checkIp(rule: Rule, clientIp: string): number {
    return this.limit(`${rule.name}:ip:${clientIp}`, rule.max, rule.windowMs);
  }

  checkAccount(rule: Rule, path: string, body: Buffer): number {
    const account = this.accountKey(path, body);
    return account ? this.limit(`${rule.name}:account:${account}`, rule.max, rule.windowMs) : 0;
  }

  async readAuthBody(req: Request): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 64 * 1024) throw new Error('Auth body too large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  }

  private accountKey(path: string, body: Buffer): string | undefined {
    let value: unknown;
    try { value = JSON.parse(body.toString('utf8')); }
    catch { return undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const fields = value as { email?: unknown; token?: unknown; unlock_token?: unknown; user?: { email?: unknown } };
    // A one-time email token is checked by Identity before password hashing. It lets the owner
    // pass an account bucket that someone else has exhausted.
    if (path === '/auth/login' && typeof fields.unlock_token === 'string' && fields.unlock_token.length > 0)
      return undefined;
    if (path === '/auth/login/unlock/request') return undefined;
    const isReset = path === '/auth/password/reset';
    const subject = isReset ? fields.token : path === '/auth/register/company' ? fields.user?.email : fields.email;
    if (typeof subject !== 'string') return undefined;
    const normalized = isReset ? subject.trim() : subject.trim().toLowerCase();
    if (!normalized || normalized.length > 320) return undefined;
    return createHash('sha256').update(`${isReset ? 'token' : 'email'}:${normalized}`).digest('hex');
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
}
