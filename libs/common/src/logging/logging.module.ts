import type { IncomingMessage } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { CORRELATION_HEADER } from '../correlation/correlation';

const correlationOf = (req: IncomingMessage): string | undefined => {
  const v = req.headers[CORRELATION_HEADER];
  return typeof v === 'string' ? v : undefined;
};

/**
 * Log แบบ JSON (pino) ฟิลด์ขั้นต่ำ: ts, level, service, correlation_id, msg
 * (docs/architecture.md §6) — ตั้ง LOG_LEVEL ได้ (ค่าเริ่มต้น info)
 */
export function createLoggingModule(service: string): DynamicModule {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service },
      messageKey: 'msg',
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: { level: (label: string) => ({ level: label }) },
      genReqId: (req) => correlationOf(req) ?? '',
      customProps: (req) => ({ correlation_id: correlationOf(req) }),
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
    },
  });
}
