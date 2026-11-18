import { Module } from '@nestjs/common';
import { StateMachineModule } from '../../state-machine/state-machine.module';
import { MyApplicationsController, StudentApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

/** ใบสมัครฝั่งนักศึกษา (หัวข้อ 1.4) — `OutboxWriter` มาจาก MessagingModule (Global) */
@Module({
  imports: [StateMachineModule],
  controllers: [StudentApplicationsController, MyApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
