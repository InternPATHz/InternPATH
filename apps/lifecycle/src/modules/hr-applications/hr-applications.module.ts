import { Module } from '@nestjs/common';
import { StateMachineModule } from '../../state-machine/state-machine.module';
import { HrApplicationsController } from './hr-applications.controller';
import { HrApplicationsService } from './hr-applications.service';

/** ใบสมัครฝั่ง HR (หัวข้อ 1.5) */
@Module({
  imports: [StateMachineModule],
  controllers: [HrApplicationsController],
  providers: [HrApplicationsService],
})
export class HrApplicationsModule {}
