import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureGateway } from './configure-gateway';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureGateway(app);
  if (process.env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(app,
      new DocumentBuilder().setTitle('InternPath gateway').addBearerAuth().build());
    SwaggerModule.setup('docs', app, document);
  }
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  app.get(Logger).log('gateway listening');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
