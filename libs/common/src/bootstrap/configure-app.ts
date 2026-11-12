import { INestApplication, RequestMethod, ValidationError, ValidationPipe } from '@nestjs/common';
import { correlationMiddleware } from '../correlation/correlation';
import { AppException, ErrorDetail } from '../errors/app-exception';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter';

function flatten(errors: ValidationError[], parent = ''): ErrorDetail[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.keys(e.constraints ?? {}).map((issue) => ({ field, issue }));
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/**
 * ตั้งค่าที่ทุก Service ต้องเหมือนกัน — ใช้ทั้งใน main.ts และในเทสต์
 *  - Correlation ID, Validation, รูปแบบ Error
 *  - prefix `/v1` (ยกเว้น /health, /ready และ /internal/**)
 */
export function configureApp(app: INestApplication): void {
  app.use(correlationMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new AppException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 400, flatten(errors)),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
      { path: 'internal/*path', method: RequestMethod.ALL },
    ],
  });
}
