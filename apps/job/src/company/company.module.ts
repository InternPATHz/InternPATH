import { Module } from '@nestjs/common';
import { CompanySnapshotService } from './company-snapshot.service';

@Module({ providers: [CompanySnapshotService], exports: [CompanySnapshotService] })
export class CompanyModule {}
