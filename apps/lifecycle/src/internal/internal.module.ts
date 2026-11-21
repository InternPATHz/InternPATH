import { Global, Module } from '@nestjs/common';
import { CategoryScopeService } from '../common/auth/category-scope.service';
import { IdentityInternalClient } from './identity-client.service';
import { JobInternalClient } from './job-client.service';
import { StudentNamesService } from './student-names.service';

@Global()
@Module({
  providers: [JobInternalClient, IdentityInternalClient, StudentNamesService, CategoryScopeService],
  exports: [JobInternalClient, IdentityInternalClient, StudentNamesService, CategoryScopeService],
})
export class InternalModule {}
