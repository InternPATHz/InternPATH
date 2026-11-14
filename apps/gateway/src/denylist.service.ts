import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class DenylistService implements OnModuleDestroy {
  private users = new Set<string>();
  private refreshedAt = 0;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;

  constructor(private readonly config: ConfigService) {}

  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  isFresh(): boolean { return this.refreshedAt > 0 && Date.now() - this.refreshedAt < 60_000; }
  has(userId: string): boolean { return this.users.has(userId); }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.fetchDenylist().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async fetchDenylist(): Promise<void> {
    const secret = this.config.get<string>('IDENTITY_SERVICE_SECRET_GATEWAY');
    const identityUrl = this.config.get<string>('IDENTITY_URL');
    if (!secret || secret.length < 32 || !identityUrl) return;
    const base = new URL(identityUrl);
    if (!['http:', 'https:'].includes(base.protocol)) return;
    const token = jwt.sign({}, secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'service' },
      issuer: 'gateway', audience: 'identity', expiresIn: 300, jwtid: randomUUID() });
    const response = await fetch(new URL('/internal/v1/denylist', base), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`Denylist HTTP ${response.status}`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' ||
      typeof (row as { user_id?: unknown }).user_id !== 'string')) throw new Error('Invalid denylist response');
    this.users = new Set(rows.map((row: { user_id: string }) => row.user_id));
    this.refreshedAt = Date.now();
  }
}
