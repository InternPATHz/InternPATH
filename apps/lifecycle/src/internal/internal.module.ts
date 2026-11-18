import { Global, Module } from '@nestjs/common';
import { IdentityInternalClient } from './identity-client.service';
import { JobInternalClient } from './job-client.service';
import { StudentNamesService } from './student-names.service';

@Global()
@Module({
  providers: [JobInternalClient, IdentityInternalClient, StudentNamesService],
  exports: [JobInternalClient, IdentityInternalClient, StudentNamesService],
})
export class InternalModule {}
