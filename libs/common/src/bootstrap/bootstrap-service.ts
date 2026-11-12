import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { configureApp } from './configure-app';

export interface BootstrapOptions {
  module: any;
  /** ชื่อ Service (ใช้ใน Swagger) */
  name: string;
  defaultPort: number;
}

/** จุดเริ่มต้นเดียวกันของทุก Service: `bootstrapService({ module: AppModule, ... })` */
export async function bootstrapService(options: BootstrapOptions): Promise<void> {
  const app = await NestFactory.create(options.module, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  // OpenAPI ที่ /docs — เฉพาะ dev (docs/architecture.md §6)
  if (process.env.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle(`InternPath ${options.name}`).addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  const port = Number(process.env.PORT ?? options.defaultPort);
  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`${options.name} listening on :${port}`);
}
