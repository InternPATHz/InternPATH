import { AppException, signServiceToken } from '@internpath/common';
import type { DirectoryCompanyIdsResponse, JobCategory } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';

const unavailable = () => new AppException('UPSTREAM_UNAVAILABLE', 'ยังกรองสายงานบริษัทไม่ได้ กรุณาลองใหม่ภายหลัง', 503);

/** Job owns job categories; Directory uses its published jobs as the category source. */
@Injectable()
export class DirectoryJobClient {
  private readonly log = new Logger(DirectoryJobClient.name);

  constructor(private readonly config: ConfigService) {}

  async companyIds(category: JobCategory): Promise<Set<string>> {
    const secret = this.config.get<string>('JOB_SERVICE_SECRET_IDENTITY');
    if (!secret || secret.length < 32) {
      this.log.error('JOB_SERVICE_SECRET_IDENTITY is missing or shorter than 32 characters');
      throw unavailable();
    }
    const base = (this.config.get<string>('JOB_URL') || 'http://localhost:3002').replace(/\/+$/, '');
    const token = signServiceToken({ issuer: 'identity', audience: 'job', secret });
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ category });
      if (cursor) query.set('after', cursor);
      let response: Response;
      try {
        response = await fetch(`${base}/internal/v1/directory/company-ids?${query}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        this.log.warn(`Job directory lookup unreachable: ${(error as Error).name}`);
        throw unavailable();
      }
      if (response.status !== 200) {
        this.log.warn(`Job directory lookup answered ${response.status}`);
        throw unavailable();
      }
      const body = (await response.json().catch(() => null)) as Partial<DirectoryCompanyIdsResponse> | null;
      if (!body || !Array.isArray(body.company_ids) || body.company_ids.some((id) => typeof id !== 'string' || !isUUID(id)) ||
          (body.next_cursor !== null && (typeof body.next_cursor !== 'string' || !isUUID(body.next_cursor))) ||
          (body.next_cursor !== null && (body.company_ids.length === 0 || body.next_cursor !== body.company_ids.at(-1)))) {
        this.log.warn('Job directory lookup answered an invalid body');
        throw unavailable();
      }
      for (const id of body.company_ids) ids.add(id.toLowerCase());
      const nextCursor = body.next_cursor;
      if (nextCursor && cursor && nextCursor <= cursor) {
        this.log.warn('Job directory lookup did not advance its cursor');
        throw unavailable();
      }
      cursor = nextCursor;
    } while (cursor);
    return ids;
  }
}
