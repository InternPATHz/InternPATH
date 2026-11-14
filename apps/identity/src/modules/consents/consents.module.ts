import { Module } from '@nestjs/common';
import { ConsentsController } from './consents.controller';
import { ConsentsService } from './consents.service';

@Module({ controllers: [ConsentsController], providers: [ConsentsService] })
export class ConsentsModule {}
