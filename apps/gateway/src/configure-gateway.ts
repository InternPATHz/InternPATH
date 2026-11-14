import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { configureApp } from '@internpath/common';
import { DenylistService } from './denylist.service';
import { GatewayMiddleware } from './gateway.middleware';

export function configureGateway(app: INestApplication): void {
  configureApp(app);
  const denylist = app.get(DenylistService);
  const gateway = new GatewayMiddleware(app.get(ConfigService), denylist);
  app.use('/api/v1', gateway.handle);
  denylist.start();
}
