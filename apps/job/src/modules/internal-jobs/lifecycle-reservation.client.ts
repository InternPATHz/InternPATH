import { signServiceToken } from '@internpath/common';
import type { ReservationCheckRequest, ReservationCheckResponse } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const RESPONSE_LIMIT_BYTES = 128 * 1024;

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT_BYTES) return undefined;
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function validateResponse(
  body: unknown,
  applicationIds: string[],
): ReservationCheckResponse | undefined {
  if (!Array.isArray(body) || body.length !== applicationIds.length) return undefined;
  const unmatched = new Set(applicationIds);
  const results: ReservationCheckResponse = [];
  for (const item of body) {
    const id: unknown = item?.application_id;
    const shouldHold: unknown = item?.should_hold_quota;
    if (typeof id !== 'string' || typeof shouldHold !== 'boolean' || !unmatched.delete(id))
      return undefined;
    results.push({ application_id: id, should_hold_quota: shouldHold });
  }
  return results;
}

@Injectable()
export class LifecycleReservationClient {
  constructor(private readonly config: ConfigService) {}

  async check(applicationIds: string[]): Promise<ReservationCheckResponse | undefined> {
    const secret = this.config.get<string>('LIFECYCLE_SERVICE_SECRET_JOB');
    if (!secret || secret.length < 32) return undefined;
    const baseUrl = this.config.get<string>('LIFECYCLE_URL', 'http://localhost:3004');
    const url = new URL('/internal/v1/applications/reservation-check', baseUrl);
    const body: ReservationCheckRequest = { application_ids: applicationIds };
    const correlationId = randomUUID();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await setTimeout(100 * attempt);
      const token = signServiceToken({ issuer: 'job', audience: 'lifecycle', secret });
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Correlation-Id': correlationId,
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        continue;
      }
      if (response.ok) {
        try {
          return validateResponse(await readResponse(response), applicationIds);
        } catch {
          return undefined;
        }
      }
      await response.body?.cancel().catch(() => undefined);
      if (![502, 503, 504].includes(response.status)) return undefined;
    }
    return undefined;
  }
}
