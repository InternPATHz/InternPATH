const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || '/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `method` ไม่ระบุ ⇒ GET เมื่อไม่มี body, POST เมื่อมี body (พฤติกรรมเดิม) */
export async function apiRequest<T>(path: string, body?: unknown, accessToken?: string, method?: HttpMethod): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiError('UPSTREAM_UNAVAILABLE', 'ระบบหลังบ้านออฟไลน์ กรุณาลองใหม่ภายหลัง', 503);
  }

  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    const code = result?.error?.code || 'REQUEST_FAILED';
    const message = response.status >= 500
      ? 'ระบบหลังบ้านออฟไลน์ กรุณาลองใหม่ภายหลัง'
      : result?.error?.message || 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
    throw new ApiError(code, message, response.status);
  }
  const text = await response.text();
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; }
  catch { throw new ApiError('INVALID_RESPONSE', 'ระบบหลังบ้านตอบกลับผิดรูปแบบ กรุณาลองใหม่', 502); }
}
