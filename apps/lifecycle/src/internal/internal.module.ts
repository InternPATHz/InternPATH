import { Global, Module } from '@nestjs/common';
import { IdentityInternalClient } from './identity-client.service';
import { JobInternalClient } from './job-client.service';

@Global()
@Module({
  providers: [JobInternalClient, IdentityInternalClient],
  exports: [JobInternalClient, IdentityInternalClient],
})
export class InternalModule {}
