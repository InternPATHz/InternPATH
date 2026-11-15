import { Module } from '@nestjs/common';
import { UserAnonymizationService } from './user-anonymization.service';

@Module({ providers: [UserAnonymizationService], exports: [UserAnonymizationService] })
export class AnonymizationModule {}
