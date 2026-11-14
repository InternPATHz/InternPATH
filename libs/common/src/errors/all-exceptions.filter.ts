import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getCorrelationId } from '../correlation/correlation';
import { AppException } from './app-exception';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN_ROLE',
  404: 'NOT_FOUND',
  409: 'STATE_CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  502: 'UPSTREAM_UNAVAILABLE',
  503: 'UPSTREAM_UNAVAILABLE',
  504: 'UPSTREAM_UNAVAILABLE',
};

/** ตัด query string ออก (อาจมี token/คำค้นที่เป็นข้อมูลส่วนบุคคล) */
const pathOnly = (url: string): string => url.split('?')[0];

/**
 * ข้อความเพื่อ log ของ error 5xx — ข้อความของ error (เช่น Prisma/pg) อาจมีค่าจริงของผู้ใช้ (อีเมลใน "duplicate key",
 * พารามิเตอร์ของ query) จึง **ตัดออกใน production** เหลือชื่อ error, code (เช่น P2002) และ stack frames
 * นอก production (dev/test) ยัง log เต็มเพื่อช่วยดีบั๊ก
 */
function describeError(exception: unknown): string {
  if (!(exception instanceof Error)) return `${typeof exception} thrown (ไม่ใช่ Error)`;
  if (process.env.NODE_ENV !== 'production') return exception.stack ?? `${exception.name}: ${exception.message}`;
  const code = (exception as { code?: unknown }).code;
  const frames = (exception.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 15)
    .join('\n');
  return `${exception.name}${typeof code === 'string' ? ` [${code}]` : ''}\n${frames}`;
}

/** แปลงทุก Exception เป็นรูปแบบเดียวกันทุก Service (docs/api-contract.md §2) */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'เกิดข้อผิดพลาดภายในระบบ';
    let details: unknown;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? 'HTTP_ERROR';
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, any>;
        if (typeof b.code === 'string') code = b.code;
        if (Array.isArray(b.message)) {
          message = 'ข้อมูลไม่ถูกต้อง';
          details = b.message.map((m: string) => ({ issue: m }));
        } else if (typeof b.message === 'string') {
          message = b.message;
        }
        if (b.details) details = b.details;
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${describeError(exception)}\ncorrelation_id=${getCorrelationId(req)}`,
        `${req.method} ${pathOnly(req.url)}`,
      );
    }

    res.status(status).json({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        correlation_id: getCorrelationId(req),
      },
    });
  }
}
