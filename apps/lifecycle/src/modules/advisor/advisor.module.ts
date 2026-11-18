import { Module } from '@nestjs/common';
import { StateMachineModule } from '../../state-machine/state-machine.module';
import { AdvisorController } from './advisor.controller';
import { AdvisorService } from './advisor.service';

/** ฝั่งอาจารย์ที่ปรึกษา (หัวข้อ 1.6) — `StudentNamesService` มาจาก InternalModule (Global) */
@Module({
  imports: [StateMachineModule],
  controllers: [AdvisorController],
  providers: [AdvisorService],
})
export class AdvisorModule {}
