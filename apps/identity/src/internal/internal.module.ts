import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { InternalService } from './internal.service';
import { ServiceTokenGuard } from './service-token.guard';

@Module({ controllers: [InternalController], providers: [InternalService, ServiceTokenGuard] })
export class InternalModule {}
