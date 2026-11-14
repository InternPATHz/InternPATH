import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import type { UserSuspendedPayload } from '@internpath/contracts';

@Injectable()
export class DenylistService implements OnModuleDestroy {
  private users = new Set<string>();
  private refreshedAt = 0;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private eventGeneration = 0;
  private readonly eventStates = new Map<string, { version: number; suspended: boolean; generation: number }>();

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

  applyEvent(payload: UserSuspendedPayload): void {
    if (!payload || typeof payload.user_id !== 'string' || payload.user_id.length === 0 ||
      typeof payload.suspended !== 'boolean' || !Number.isSafeInteger(payload.entity_version) ||
      payload.entity_version < 0) throw new Error('Invalid UserSuspended payload');
    const previous = this.eventStates.get(payload.user_id);
    if (previous && previous.version >= payload.entity_version) return;
    const generation = ++this.eventGeneration;
    this.eventStates.set(payload.user_id, { version: payload.entity_version,
      suspended: payload.suspended, generation });
    if (payload.suspended) this.users.add(payload.user_id);
    else this.users.delete(payload.user_id);
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.fetchDenylist().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async fetchDenylist(): Promise<void> {
    const generationAtStart = this.eventGeneration;
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
    const users = new Set(rows.map((row: { user_id: string }) => row.user_id));
    for (const [userId, state] of this.eventStates) {
      if (state.generation <= generationAtStart) continue;
      if (state.suspended) users.add(userId);
      else users.delete(userId);
    }
    this.users = users;
    this.refreshedAt = Date.now();
  }
}
