import { randomUUID } from 'node:crypto';
import { AppException } from '@internpath/common';

export interface InternalRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  serviceToken?: string | (() => string);
  correlationId?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * HTTP Client สำหรับเรียก Internal API ข้าม Service ตาม docs/api-contract.md §9 และ README §5.7
 * - Timeout 3 วินาที
 * - Retry สูงสุด 2 ครั้ง (รวมลอง 3 ครั้ง) เมื่อเกิด Network error / 502 / 503 / 504
 * - แนบ Service Token ใน Header Authorization
 * - ห้ามเรียกวนกลับ
 */
export async function fetchInternal<T>(url: string, options: InternalRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxRetries = options.maxRetries ?? 2;
  const correlationId = options.correlationId ?? randomUUID();

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Correlation-Id': correlationId,
  };

  let bodyString: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyString = JSON.stringify(options.body);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (options.serviceToken) {
        const token = typeof options.serviceToken === 'function' ? options.serviceToken() : options.serviceToken;
        headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method,
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        if (response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      }

      // ตรวจว่าสามารถ retry ได้หรือไม่ (502, 503, 504)
      if ([502, 503, 504].includes(response.status) && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }

      // ดึง error code และข้อความจาก standard error response
      let errorBody: any;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = undefined;
      }

      const code = errorBody?.error?.code ?? (response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'BAD_REQUEST');
      const message = errorBody?.error?.message ?? `Internal API request failed with status ${response.status}`;
      throw new AppException(code, message, response.status, errorBody?.error?.details);
    } catch (error) {
      lastError = error;
      if (error instanceof AppException) {
        throw error;
      }
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
    }
  }

  throw new AppException(
    'UPSTREAM_UNAVAILABLE',
    `ไม่สามารถเชื่อมต่อ Service ปลายทางได้หลังลองซ้ำ (${(lastError as Error)?.message ?? 'timeout'})`,
    502,
  );
}
