import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, signServiceToken } from '@internpath/common';
import type {
  ConsentCheckRequest,
  ConsentCheckResponse,
  InternalCompanyMembersResponse,
  InternalStudentResponse,
} from '@internpath/contracts';
import { fetchInternal } from './internal-http.client';

export const IDENTITY_SERVICE_SECRET_ENV = 'IDENTITY_SERVICE_SECRET_LIFECYCLE';

@Injectable()
export class IdentityInternalClient {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('IDENTITY_URL', 'http://localhost:3001');
  }

  private getServiceToken(): string {
    const secret = this.config.get<string>(IDENTITY_SERVICE_SECRET_ENV);
    if (!secret || secret.length < 32) {
      throw new AppException(
        'AUTH_NOT_CONFIGURED',
        `${IDENTITY_SERVICE_SECRET_ENV} is not configured or shorter than 32 characters`,
        500,
      );
    }
    return signServiceToken({
      issuer: 'lifecycle',
      audience: 'identity',
      secret,
    });
  }

  async getStudent(userId: string, correlationId?: string): Promise<InternalStudentResponse> {
    const url = `${this.baseUrl}/internal/v1/students/${userId}`;
    return fetchInternal<InternalStudentResponse>(url, {
      method: 'GET',
      serviceToken: this.getServiceToken(),
      correlationId,
    });
  }

  async checkConsent(studentUserId: string, companyId: string, correlationId?: string): Promise<ConsentCheckResponse> {
    const url = `${this.baseUrl}/internal/v1/consents/check`;
    const body: ConsentCheckRequest = { student_user_id: studentUserId, company_id: companyId };
    return fetchInternal<ConsentCheckResponse>(url, {
      method: 'POST',
      body,
      serviceToken: this.getServiceToken(),
      correlationId,
    });
  }

  async getCompanyMembers(companyId: string, correlationId?: string): Promise<InternalCompanyMembersResponse> {
    const url = `${this.baseUrl}/internal/v1/companies/${companyId}/members`;
    return fetchInternal<InternalCompanyMembersResponse>(url, {
      method: 'GET',
      serviceToken: this.getServiceToken(),
      correlationId,
    });
  }
}
