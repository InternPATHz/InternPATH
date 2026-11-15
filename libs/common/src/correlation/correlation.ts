import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** docs/architecture.md §6 — Correlation ID */
export const CORRELATION_HEADER = 'x-correlation-id';

const SAFE_ID = /^[\w-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/** DB correlation columns require UUIDs, while incoming headers may use other safe IDs. */
export const asUuid = (value?: string): string => value && isUuid(value) ? value : randomUUID();

/** ใช้ค่าจาก Header ถ้าหน้าตาปลอดภัย (กัน log injection) ไม่เช่นนั้นสร้างใหม่ */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.headers[CORRELATION_HEADER] = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}

export function getCorrelationId(req: Pick<Request, 'headers'>): string | undefined {
  const v = req.headers[CORRELATION_HEADER];
  return typeof v === 'string' ? v : undefined;
}
