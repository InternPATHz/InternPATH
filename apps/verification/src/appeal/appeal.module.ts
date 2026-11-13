import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AppealController } from './appeal.controller';
import { AppealService } from './appeal.service';

@Module({ imports: [QueueModule], controllers: [AppealController], providers: [AppealService] })
export class AppealModule {}
