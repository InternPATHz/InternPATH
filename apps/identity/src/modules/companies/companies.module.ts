import { Module } from '@nestjs/common';
import { AdminCompaniesController, CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { CompanyStorageService } from './company-storage.service';

@Module({ controllers: [CompaniesController, AdminCompaniesController], providers: [CompaniesService, CompanyStorageService] })
export class CompaniesModule {}
