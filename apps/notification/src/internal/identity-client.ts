import { signServiceToken } from '@internpath/common';
import type {
  InternalAdminsResponse,
  InternalCompanyMembersResponse,
  UserContact,
} from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class IdentityClient {
  constructor(private readonly config: ConfigService) {}

  async members(companyId: string, correlationId: string): Promise<InternalCompanyMembersResponse> {
    return (
      (await this.get<InternalCompanyMembersResponse>(
        `companies/${encodeURIComponent(companyId)}/members`,
        correlationId,
      )) ?? []
    );
  }

  async admins(correlationId: string): Promise<InternalAdminsResponse> {
    return (await this.get<InternalAdminsResponse>('admins', correlationId)) ?? [];
  }

  contact(userId: string): Promise<UserContact | undefined> {
    return this.get<UserContact>(`users/${encodeURIComponent(userId)}/contact`);
  }

  async existingUsers(ids: string[], correlationId: string): Promise<Set<string>> {
    const known = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const idsQuery = encodeURIComponent(ids.slice(offset, offset + 100).join(','));
      const contacts = await this.get<UserContact[]>(
        `users/contacts?ids=${idsQuery}`,
        correlationId,
      );
      for (const contact of contacts ?? []) known.add(contact.user_id);
    }
    return known;
  }

  private async get<T>(path: string, correlationId?: string): Promise<T | undefined> {
    const base = this.config
      .get<string>('IDENTITY_URL', 'http://localhost:3001')
      .replace(/\/$/, '');
    const secret = this.config.get<string>('IDENTITY_SERVICE_SECRET_NOTIFICATION');
    if (!secret || secret.length < 32)
      throw new Error('Notification service credentials are unavailable');
    const headers = {
      Authorization: `Bearer ${signServiceToken({ issuer: 'notification', audience: 'identity', secret })}`,
      ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${base}/internal/v1/${path}`, {
        headers,
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
      if (response?.ok) return (await response.json()) as T;
      if (response?.status === 404) return;
      if (response && response.status < 500) break;
    }
    throw new Error('Identity lookup failed');
  }
}
