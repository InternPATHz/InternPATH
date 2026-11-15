import { Global, Module } from '@nestjs/common';
import { LifecycleConfigService } from './lifecycle-config.service';

@Global()
@Module({
  providers: [LifecycleConfigService],
  exports: [LifecycleConfigService],
})
export class LifecycleConfigModule {}
