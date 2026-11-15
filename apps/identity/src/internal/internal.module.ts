import { Module } from '@nestjs/common';
import { ServiceTokenGuard } from '@internpath/common';
import { InternalController } from './internal.controller';
import { InternalService } from './internal.service';

@Module({ controllers: [InternalController], providers: [InternalService, ServiceTokenGuard] })
export class InternalModule {}
